#!/bin/bash
set -e
set -o pipefail

PR_NUMBER="${1}"
REPO_NAME="${2}"
BASE_REF="${3}"
API_KEY="${GOOGLE_API_KEY}"

if [ -z "$PR_NUMBER" ] || [ -z "$REPO_NAME" ] || [ -z "$BASE_REF" ]; then
  echo "Usage: $0 <PR_NUMBER> <REPO_NAME> <BASE_REF>"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "Error: GOOGLE_API_KEY environment variable is not set."
  exit 1
fi

BASE_URL="https://jules.googleapis.com/v1alpha"

echo "Starting Jules Review (API Mode) for PR #${PR_NUMBER} in repo ${REPO_NAME} against ${BASE_REF}"

# 1. Find Source
echo "Resolving Source ID for ${REPO_NAME}..."
SOURCES_RESP=$(curl -s -H "X-Goog-Api-Key: ${API_KEY}" "${BASE_URL}/sources")

# Note: Debugging output removed to prevent leaking API Key if it somehow ends up in headers/output,
# though here it is in a variable. But keeping logs clean is better.
# echo "Sources Response: $SOURCES_RESP"

OWNER=${REPO_NAME%/*}
REPO=${REPO_NAME#*/}

SOURCE_ID=$(echo "$SOURCES_RESP" | jq -r --arg o "$OWNER" --arg r "$REPO" \
  '.sources[]? | select(.githubRepo.owner == $o and .githubRepo.repo == $r) | .name')

if [ -z "$SOURCE_ID" ] || [ "$SOURCE_ID" == "null" ]; then
  echo "Error: Could not find source for ${REPO_NAME}."
  # Print response ONLY if safe? Response likely safe.
  echo "Debug: Source response: $SOURCES_RESP"
  exit 1
fi

echo "Found Source ID: ${SOURCE_ID}"

# 2. Create Session
PROMPT="You are a Senior Reviewer Agent.
Review Pull Request #${PR_NUMBER}.
Instructions:
1. Fetch PR changes (git fetch origin pull/${PR_NUMBER}/head:pr-${PR_NUMBER} && git checkout pr-${PR_NUMBER}).
2. Read AGENTS.md for coding standards.
3. Review the code changes (git diff origin/${BASE_REF}...HEAD).
    a. Do a comprehensive review.
    b. Review the tests.
    c. Run up to date linters on the code changes.
    d. Review for vulnerabilities.
    e. Review for performance.
    f. Review for UX.
    g. Review for maintainability.
    h. Review for bugs.
    i. Review for secrets in the code.
    j. Review for leaks.
    k. Review code quality.
    l. Review styling.
    m. Review for adherence to repo standards.
4. Your final comment *ALWAYS* will be your findings organized into blocking issues and non-blocking suggestions.
"

PAYLOAD=$(jq -n \
  --arg src "$SOURCE_ID" \
  --arg p "$PROMPT" \
  --arg branch "$BASE_REF" \
  '{
    prompt: $p,
    sourceContext: {
      source: $src,
      githubRepoContext: {
        startingBranch: $branch
      }
    }
  }')

echo "Creating Session..."
SESSION_RESP=$(curl -s -X POST \
  -H "X-Goog-Api-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "${BASE_URL}/sessions")

# echo "Session Response: $SESSION_RESP"

SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.name')

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" == "null" ]; then
  echo "Error: Failed to create session."
  echo "Debug: Session response: $SESSION_RESP"
  exit 1
fi

echo "Session Created: ${SESSION_ID}"

# 3. Poll
echo "Waiting for completion..."
STATUS="UNKNOWN"
FINAL_ACT_RESP=""

for i in {1..60}; do
  sleep 10
  
  ACT_RESP=$(curl -s -H "X-Goog-Api-Key: ${API_KEY}" "${BASE_URL}/${SESSION_ID}/activities")
  
  # Check for sessionCompleted activity
  IS_COMPLETED=$(echo "$ACT_RESP" | jq -r '.activities[]? | select(.sessionCompleted != null) | .name')
  
  if [ ! -z "$IS_COMPLETED" ]; then
    echo "Session Completed."
    STATUS="COMPLETED"
    FINAL_ACT_RESP="$ACT_RESP"
    break
  fi
  
  echo "Poll $i: Running..."
done

if [ "$STATUS" != "COMPLETED" ]; then
  echo "Timeout waiting for session."
  # Dump activities? Safe? Activities usually contain prompt and code snippets.
  # Should be safe as they are project content.
  # curl -s -H "X-Goog-Api-Key: ${API_KEY}" "${BASE_URL}/${SESSION_ID}/activities"
  exit 1
fi

# 4. Extract Result
echo "Extracting Result..."

# Try patch extraction
PATCH=$(echo "$FINAL_ACT_RESP" | jq -r '[.activities[]?.artifacts[]? | .changeSet.gitPatch.unidiffPatch | select(. != null)] | last')

if [ ! -z "$PATCH" ] && [ "$PATCH" != "null" ]; then
    echo "Found patch. Applying..."
    echo "$PATCH" > review.patch
    git apply review.patch || echo "Warning: Failed to apply patch. Continuing check for fallback..."
fi

if [ ! -f "REVIEW.md" ]; then
    echo "REVIEW.md not found in patch. Checking for text summary..."
    # Fallback to description from progressUpdated
    SUMMARY=$(echo "$FINAL_ACT_RESP" | jq -r '[.activities[]?.progressUpdated?.description | select(. != null)] | last')
    
    if [ ! -z "$SUMMARY" ] && [ "$SUMMARY" != "null" ]; then
        echo "Found text summary."
        echo "# Jules Review (Summary)" > REVIEW.md
        echo "" >> REVIEW.md
        echo "$SUMMARY" >> REVIEW.md
    else
         echo "No review content found (neither file nor text summary)."
         # Dump for debug
         # echo "$FINAL_ACT_RESP"
         exit 1
    fi
fi

echo "Posting Review..."
gh pr comment "$PR_NUMBER" --body-file REVIEW.md
echo "Success."
