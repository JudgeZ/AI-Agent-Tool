#!/bin/bash
set -x
set -e

PR_NUMBER="${1}"
REPO_NAME="${2}"
BASE_REF="${3:-main}"
API_KEY="${GOOGLE_API_KEY}"

if [ -z "$PR_NUMBER" ] || [ -z "$REPO_NAME" ]; then
  echo "Usage: $0 <PR_NUMBER> <REPO_NAME> [BASE_REF]"
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

# Debug output
echo "Sources Response: $SOURCES_RESP"

OWNER=${REPO_NAME%/*}
REPO=${REPO_NAME#*/}

SOURCE_ID=$(echo "$SOURCES_RESP" | jq -r --arg o "$OWNER" --arg r "$REPO" \
  '.sources[]? | select(.githubRepo.owner == $o and .githubRepo.repo == $r) | .name')

if [ -z "$SOURCE_ID" ] || [ "$SOURCE_ID" == "null" ]; then
  echo "Error: Could not find source for ${REPO_NAME}."
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
4. Create a file named 'REVIEW.md' with your summary and specific comments.
   - Format it as Markdown.
   - List any Critical Issues (Blocking).
   - List Suggestions (Non-blocking).
5. Do NOT use gh CLI.
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

echo "Session Response: $SESSION_RESP"

SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.name')

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" == "null" ]; then
  echo "Error: Failed to create session."
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
  curl -s -H "X-Goog-Api-Key: ${API_KEY}" "${BASE_URL}/${SESSION_ID}/activities"
  exit 1
fi

# 4. Extract Patch
echo "Extracting Patch..."
PATCH=$(echo "$FINAL_ACT_RESP" | jq -r '[.activities[]?.artifacts[]? | .changeSet.gitPatch.unidiffPatch | select(. != null)] | last')

if [ -z "$PATCH" ] || [ "$PATCH" == "null" ]; then
  echo "Error: No patch found in activities."
  echo "$FINAL_ACT_RESP"
  exit 1
fi

echo "$PATCH" > review.patch

echo "Applying patch..."
git apply review.patch || { echo "Git apply failed. Patch content:"; cat review.patch; exit 1; }

if [ -f "REVIEW.md" ]; then
  echo "Posting Review..."
  gh pr comment "$PR_NUMBER" --body-file REVIEW.md
  echo "Success."
else
  echo "Error: REVIEW.md not found after patch."
  exit 1
fi
