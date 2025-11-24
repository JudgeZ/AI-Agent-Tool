#!/bin/bash
set -e

PR_NUMBER="${1}"

if [ -z "$PR_NUMBER" ]; then
  echo "Usage: $0 <PR_NUMBER>"
  exit 1
fi

echo "Starting Jules Review for PR #${PR_NUMBER}"

# Define the prompt
PROMPT="You are a Senior Reviewer Agent.
Your task is to review Pull Request #${PR_NUMBER}.

Instructions:
1. The repository is already cloned. Fetch the PR changes:
   git fetch origin pull/${PR_NUMBER}/head:pr-${PR_NUMBER}
   git checkout pr-${PR_NUMBER}
2. Read AGENTS.md for coding standards.
3. Review the code changes (git diff main...HEAD).
4. Create a file named 'REVIEW.md' with your summary and specific comments.
   - Format it as Markdown.
   - List any Critical Issues (Blocking).
   - List Suggestions (Non-blocking).
   - Reference file names and line numbers clearly.
5. Do NOT try to use 'gh' CLI.
6. Verify 'REVIEW.md' exists before finishing.
"

echo "Launching session..."
# Capture stdout and stderr
OUTPUT=$(jules new --repo . "$PROMPT" 2>&1)
echo "$OUTPUT"

# Extract session ID. Format usually includes "sessions/<number>"
SESSION_ID=$(echo "$OUTPUT" | grep -oE "sessions/[0-9]+" | head -n 1)

if [ -z "$SESSION_ID" ]; then
    echo "Error: Could not extract Session ID."
    # Fallback: check if the command failed
    exit 1
fi

echo "Session ID: $SESSION_ID"

# Poll loop
echo "Waiting for session to complete..."
STATUS="UNKNOWN"
for i in {1..60}; do
    sleep 10
    # List sessions and find ours.
    # We assume 'jules remote list --session' output contains the ID and a status column.
    LIST_OUTPUT=$(jules remote list --session 2>/dev/null || true)
    LINE=$(echo "$LIST_OUTPUT" | grep "$SESSION_ID" || true)

    # If output is empty, maybe auth failed in list?
    if [ -z "$LIST_OUTPUT" ]; then
       echo "Warning: failed to list sessions."
    fi

    # Simple check for keywords
    # If the session disappears or is marked done
    if [[ "$LINE" == *"COMPLETED"* ]] || [[ "$LINE" == *"SUCCEEDED"* ]] || [[ "$LINE" == *"DONE"* ]]; then
        STATUS="COMPLETED"
        break
    elif [[ "$LINE" == *"FAILED"* ]] || [[ "$LINE" == *"ERROR"* ]]; then
        STATUS="FAILED"
        echo "Session failed: $LINE"
        exit 1
    fi

    echo "Status check $i: $LINE"
done

if [ "$STATUS" != "COMPLETED" ]; then
    echo "Timed out waiting for session or status unknown."
    # Try to pull anyway, maybe it finished?
fi

echo "Pulling results..."
jules remote pull --session "$SESSION_ID" --apply

if [ -f "REVIEW.md" ]; then
    echo "Posting review to GitHub..."
    gh pr comment "$PR_NUMBER" --body-file REVIEW.md
    echo "Done."
else
    echo "Error: REVIEW.md not generated."
    exit 1
fi
