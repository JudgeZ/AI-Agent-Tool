#!/bin/bash
set -x # Enable debug
set -e

PR_NUMBER="${1}"
REPO_NAME="${2}"

if [ -z "$PR_NUMBER" ] || [ -z "$REPO_NAME" ]; then
  echo "Usage: $0 <PR_NUMBER> <REPO_NAME>"
  exit 1
fi

echo "Starting Jules Review for PR #${PR_NUMBER} in repo ${REPO_NAME}"

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
OUTPUT=$(jules new --repo "$REPO_NAME" "$PROMPT" 2>&1)
echo "DEBUG: Output from jules new:"
echo "$OUTPUT"
echo "--------------------------------"

# Extract session ID.
# Try to find 'sessions/12345'
RAW_ID=$(echo "$OUTPUT" | grep -oE "sessions/[0-9]+" | head -n 1)

# If failed, look for any long number sequence (e.g. 15+ digits)
if [ -z "$RAW_ID" ]; then
  RAW_ID=$(echo "$OUTPUT" | grep -oE "[0-9]{15,}" | head -n 1)
fi

if [ -z "$RAW_ID" ]; then
    echo "Error: Could not extract Session ID from output."
    exit 1
fi

# Clean ID (remove sessions/ prefix)
SESSION_ID=${RAW_ID##sessions/}

echo "Extracted Session ID: $SESSION_ID"

# Poll loop
echo "Waiting for session to complete..."
STATUS="UNKNOWN"
for i in {1..60}; do
    sleep 10

    # Check remote list
    LIST_OUTPUT=$(jules remote list --session 2>&1 || true)

    # Grep for the ID
    LINE=$(echo "$LIST_OUTPUT" | grep "$SESSION_ID" || true)

    echo "DEBUG: Status check $i: $LINE"

    if [[ "$LINE" == *"COMPLETED"* ]] || [[ "$LINE" == *"SUCCEEDED"* ]] || [[ "$LINE" == *"DONE"* ]]; then
        STATUS="COMPLETED"
        break
    elif [[ "$LINE" == *"FAILED"* ]] || [[ "$LINE" == *"ERROR"* ]]; then
        STATUS="FAILED"
        echo "Session failed: $LINE"
        exit 1
    fi
done

if [ "$STATUS" != "COMPLETED" ]; then
    echo "Timed out waiting for session or status unknown. Attempting pull anyway..."
fi

echo "Pulling results for Session $SESSION_ID..."
jules remote pull --session "$SESSION_ID" --apply

if [ -f "REVIEW.md" ]; then
    echo "Posting review to GitHub..."
    gh pr comment "$PR_NUMBER" --body-file REVIEW.md
    echo "Done."
else
    echo "Error: REVIEW.md not generated."
    ls -la # Debug: show what files exist
    exit 1
fi
