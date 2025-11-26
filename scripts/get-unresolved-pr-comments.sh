#!/usr/bin/env bash
#
# Fetch unresolved PR comments from GitHub
#
# Usage:
#   ./scripts/get-unresolved-pr-comments.sh <pr_number> [owner/repo]
#
# Examples:
#   ./scripts/get-unresolved-pr-comments.sh 36
#   ./scripts/get-unresolved-pr-comments.sh 36 JudgeZ/AI-Agent-Tool
#
# Environment:
#   GITHUB_TOKEN - GitHub personal access token (optional, increases rate limit)
#
# Output:
#   JSON array of unresolved comments with file, line, author, and body
#

set -euo pipefail

PR_NUMBER="${1:-}"
REPO="${2:-}"

if [[ -z "$PR_NUMBER" ]]; then
  echo "Usage: $0 <pr_number> [owner/repo]" >&2
  echo "Example: $0 36 JudgeZ/AI-Agent-Tool" >&2
  exit 1
fi

# Auto-detect repo from git remote if not provided
if [[ -z "$REPO" ]]; then
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
  if [[ -n "$REMOTE_URL" ]]; then
    # Handle SSH format: git@github.com:owner/repo.git
    # Handle HTTPS format: https://github.com/owner/repo.git
    REPO=$(echo "$REMOTE_URL" | sed -E 's#^(https://github\.com/|git@github\.com:)##' | sed -E 's#\.git$##')
  fi
fi

if [[ -z "$REPO" ]]; then
  echo "Error: Could not detect repository. Please provide owner/repo as second argument." >&2
  exit 1
fi

# Create temp directory for intermediate files
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Set up auth header if token is available
AUTH_HEADER=""
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  AUTH_HEADER="Authorization: Bearer $GITHUB_TOKEN"
fi

# Function to make GitHub API request with pagination
fetch_all_pages() {
  local endpoint="$1"
  local output_file="$2"
  local page=1

  echo "[]" > "$output_file"

  while true; do
    local url="https://api.github.com/${endpoint}?per_page=100&page=${page}"
    local response_file="$TMPDIR/response_${page}.json"

    if [[ -n "$AUTH_HEADER" ]]; then
      curl -s -H "$AUTH_HEADER" -H "Accept: application/vnd.github.v3+json" "$url" > "$response_file"
    else
      curl -s -H "Accept: application/vnd.github.v3+json" "$url" > "$response_file"
    fi

    # Check if response is empty array
    if [[ "$(cat "$response_file")" == "[]" ]] || [[ ! -s "$response_file" ]]; then
      break
    fi

    # Check for API errors
    if jq -e '.message' "$response_file" &>/dev/null; then
      echo "API Error: $(jq -r '.message' "$response_file")" >&2
      exit 1
    fi

    # Merge results
    jq -s '.[0] + .[1]' "$output_file" "$response_file" > "$TMPDIR/merged.json"
    mv "$TMPDIR/merged.json" "$output_file"

    # Check if we got fewer than 100 results (last page)
    local count
    count=$(jq 'length' "$response_file")
    if [[ "$count" -lt 100 ]]; then
      break
    fi

    ((page++))
  done
}

echo "Fetching PR #${PR_NUMBER} comments from ${REPO}..." >&2

# Fetch review comments (code comments)
echo "  Fetching review comments..." >&2
REVIEW_FILE="$TMPDIR/review_comments.json"
fetch_all_pages "repos/${REPO}/pulls/${PR_NUMBER}/comments" "$REVIEW_FILE"

# Fetch review threads to check resolution status
echo "  Fetching review threads..." >&2
RESOLVED_FILE="$TMPDIR/resolved_ids.json"
echo "[]" > "$RESOLVED_FILE"

if [[ -n "$AUTH_HEADER" ]]; then
  # GraphQL query to get review threads with resolution status
  OWNER=$(echo "$REPO" | cut -d'/' -f1)
  REPO_NAME=$(echo "$REPO" | cut -d'/' -f2)

  GRAPHQL_QUERY="{\"query\": \"query { repository(owner: \\\"$OWNER\\\", name: \\\"$REPO_NAME\\\") { pullRequest(number: $PR_NUMBER) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { id databaseId } } } } } } }\"}"

  curl -s -X POST \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$GRAPHQL_QUERY" \
    "https://api.github.com/graphql" > "$TMPDIR/threads.json" 2>/dev/null || echo '{}' > "$TMPDIR/threads.json"

  # Extract resolved comment IDs
  jq -r '
    [.data.repository.pullRequest.reviewThreads.nodes[]? |
     select(.isResolved == true) |
     .comments.nodes[]?.databaseId] |
    map(select(. != null))
  ' "$TMPDIR/threads.json" > "$RESOLVED_FILE" 2>/dev/null || echo "[]" > "$RESOLVED_FILE"
fi

# Filter out resolved comments and format output
UNRESOLVED_FILE="$TMPDIR/unresolved.json"
jq --slurpfile resolved "$RESOLVED_FILE" '
  [.[] |
   select(.id as $id | ($resolved[0] | index($id)) == null) |
   {
     id: .id,
     author: .user.login,
     file: .path,
     line: (.line // .original_line),
     created_at: .created_at,
     updated_at: .updated_at,
     body: .body,
     url: .html_url,
     in_reply_to: .in_reply_to_id
   }
  ]
' "$REVIEW_FILE" > "$UNRESOLVED_FILE"

# Fetch issue comments (non-code PR comments)
echo "  Fetching issue comments..." >&2
ISSUE_FILE="$TMPDIR/issue_comments.json"
fetch_all_pages "repos/${REPO}/issues/${PR_NUMBER}/comments" "$ISSUE_FILE"

ISSUE_FORMATTED_FILE="$TMPDIR/issue_formatted.json"
jq '
  [.[] |
   {
     id: .id,
     author: .user.login,
     file: null,
     line: null,
     created_at: .created_at,
     updated_at: .updated_at,
     body: .body,
     url: .html_url,
     type: "issue_comment"
   }
  ]
' "$ISSUE_FILE" > "$ISSUE_FORMATTED_FILE"

# Combine and output
jq -n \
  --argjson pr "$PR_NUMBER" \
  --arg repo "$REPO" \
  --slurpfile review "$UNRESOLVED_FILE" \
  --slurpfile issue "$ISSUE_FORMATTED_FILE" \
  '{
    pr_number: $pr,
    repository: $repo,
    fetched_at: (now | todate),
    review_comments: {
      total: ($review[0] | length),
      unresolved: ([$review[0][] | select(.in_reply_to == null)] | length),
      comments: $review[0]
    },
    issue_comments: {
      total: ($issue[0] | length),
      comments: $issue[0]
    }
  }'

# Print summary to stderr
REVIEW_COUNT=$(jq 'length' "$UNRESOLVED_FILE")
ISSUE_COUNT=$(jq 'length' "$ISSUE_FORMATTED_FILE")
echo "" >&2
echo "Summary:" >&2
echo "  Unresolved review comments: $REVIEW_COUNT" >&2
echo "  Issue comments: $ISSUE_COUNT" >&2
