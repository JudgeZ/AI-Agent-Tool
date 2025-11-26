#!/usr/bin/env bash
#
# Fetch unresolved PR review comments and AI reviewer comments from GitHub
#
# Usage:
#   ./scripts/get-unresolved-pr-comments.sh <pr_number> [owner/repo]
#
# Examples:
#   ./scripts/get-unresolved-pr-comments.sh 36
#   ./scripts/get-unresolved-pr-comments.sh 36 JudgeZ/AI-Agent-Tool
#
# Environment:
#   GITHUB_TOKEN - GitHub personal access token (required for resolution status)
#                  Required scopes: repo (private repos) or public_repo (public repos)
#                  Used for: REST API (comments), GraphQL API (resolution status)
#
# Config:
#   .local/pr-comments-handled.json - Track handled comments to exclude from output
#   Format:
#     {
#       "36": {
#         "12345": { "status": "validated", "note": "Fixed in commit abc123" },
#         "67890": { "status": "ignored", "note": "Added to ignored.md as I46" }
#       }
#     }
#   Status values:
#     validated - Code change made to address the comment
#     ignored   - Added to ignored.md with rationale (not addressing)
#     wontfix   - Added to ignored.md with rationale (won't address)
#     deferred  - Added to ignored.md with rationale (will address later)
#
# Output:
#   JSON with review comments and AI reviewer issue comments (Claude, CodeRabbit)
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
    REPO=$(echo "$REMOTE_URL" | sed -E 's#^(https://github\.com/|git@github\.com:)##' | sed -E 's#\.git$##')
  fi
fi

if [[ -z "$REPO" ]]; then
  echo "Error: Could not detect repository. Please provide owner/repo as second argument." >&2
  exit 1
fi

# Find repo root for config file
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CONFIG_FILE="$REPO_ROOT/.local/pr-comments-handled.json"
HANDLED_IDS_FILE=""

# Load handled comment IDs from config if it exists
if [[ -f "$CONFIG_FILE" ]]; then
  echo "  Loading handled comments from $CONFIG_FILE..." >&2
  # Create temp file with handled IDs for this PR
  HANDLED_IDS_FILE=$(mktemp)
  jq -r --arg pr "$PR_NUMBER" '
    .[$pr] // {} | keys | map(tonumber) | sort
  ' "$CONFIG_FILE" > "$HANDLED_IDS_FILE" 2>/dev/null || echo "[]" > "$HANDLED_IDS_FILE"

  HANDLED_COUNT=$(jq 'length' "$HANDLED_IDS_FILE")
  if [[ "$HANDLED_COUNT" -gt 0 ]]; then
    echo "  Found $HANDLED_COUNT previously handled comments to exclude" >&2
  fi
else
  echo "  No config file found at $CONFIG_FILE (all comments will be shown)" >&2
fi

# Create temp directory for intermediate files
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"; [[ -n "${HANDLED_IDS_FILE:-}" ]] && rm -f "$HANDLED_IDS_FILE"' EXIT

# Set up auth header if token is available
AUTH_HEADER=""
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  AUTH_HEADER="Authorization: Bearer $GITHUB_TOKEN"
else
  echo "Warning: GITHUB_TOKEN not set. Cannot determine resolution status." >&2
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

# Fetch issue comments (for AI reviewer comments)
echo "  Fetching issue comments (AI reviews)..." >&2
ISSUE_FILE="$TMPDIR/issue_comments.json"
fetch_all_pages "repos/${REPO}/issues/${PR_NUMBER}/comments" "$ISSUE_FILE"

# Fetch review threads to check resolution status and PR reviews (requires GITHUB_TOKEN)
RESOLVED_FILE="$TMPDIR/resolved_ids.json"
OUTDATED_FILE="$TMPDIR/outdated_ids.json"
PR_REVIEWS_FILE="$TMPDIR/pr_reviews_raw.json"
echo "[]" > "$RESOLVED_FILE"
echo "[]" > "$OUTDATED_FILE"
echo "[]" > "$PR_REVIEWS_FILE"

if [[ -n "$AUTH_HEADER" ]]; then
  echo "  Fetching review threads and PR reviews (with pagination)..." >&2

  OWNER=$(echo "$REPO" | cut -d'/' -f1)
  REPO_NAME=$(echo "$REPO" | cut -d'/' -f2)

  # Function to fetch paginated GraphQL data
  fetch_graphql_paginated() {
    local all_threads="$TMPDIR/all_threads.json"
    local all_reviews="$TMPDIR/all_reviews.json"
    echo "[]" > "$all_threads"
    echo "[]" > "$all_reviews"

    local threads_cursor=""
    local reviews_cursor=""
    local has_more_threads="true"
    local has_more_reviews="true"
    local page=1

    while [[ "$has_more_threads" == "true" || "$has_more_reviews" == "true" ]]; do
      # Build cursor arguments
      local threads_after=""
      local reviews_after=""
      [[ -n "$threads_cursor" ]] && threads_after=", after: \\\"$threads_cursor\\\""
      [[ -n "$reviews_cursor" ]] && reviews_after=", after: \\\"$reviews_cursor\\\""

      # GraphQL query with pagination
      local GRAPHQL_QUERY="{\"query\": \"query { repository(owner: \\\"$OWNER\\\", name: \\\"$REPO_NAME\\\") { pullRequest(number: $PR_NUMBER) { reviewThreads(first: 100$threads_after) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated comments(first: 1) { nodes { id databaseId } } } } reviews(first: 100$reviews_after) { pageInfo { hasNextPage endCursor } nodes { id databaseId body state author { login } submittedAt url } } } } }\"}"

      curl -s -X POST \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        -d "$GRAPHQL_QUERY" \
        "https://api.github.com/graphql" > "$TMPDIR/page_${page}.json" 2>/dev/null || echo '{}' > "$TMPDIR/page_${page}.json"

      # Check for errors
      if jq -e '.errors' "$TMPDIR/page_${page}.json" &>/dev/null; then
        echo "    GraphQL Error on page $page: $(jq -r '.errors[0].message' "$TMPDIR/page_${page}.json")" >&2
        break
      fi

      # Extract and merge threads
      jq -r '[.data.repository.pullRequest.reviewThreads.nodes[]?]' "$TMPDIR/page_${page}.json" > "$TMPDIR/threads_page.json" 2>/dev/null || echo "[]" > "$TMPDIR/threads_page.json"
      jq -s '.[0] + .[1]' "$all_threads" "$TMPDIR/threads_page.json" > "$TMPDIR/merged_threads.json"
      mv "$TMPDIR/merged_threads.json" "$all_threads"

      # Extract and merge reviews
      jq -r '[.data.repository.pullRequest.reviews.nodes[]?]' "$TMPDIR/page_${page}.json" > "$TMPDIR/reviews_page.json" 2>/dev/null || echo "[]" > "$TMPDIR/reviews_page.json"
      jq -s '.[0] + .[1]' "$all_reviews" "$TMPDIR/reviews_page.json" > "$TMPDIR/merged_reviews.json"
      mv "$TMPDIR/merged_reviews.json" "$all_reviews"

      # Check pagination status
      has_more_threads=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage // false' "$TMPDIR/page_${page}.json")
      has_more_reviews=$(jq -r '.data.repository.pullRequest.reviews.pageInfo.hasNextPage // false' "$TMPDIR/page_${page}.json")

      # Update cursors
      if [[ "$has_more_threads" == "true" ]]; then
        threads_cursor=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' "$TMPDIR/page_${page}.json")
      fi
      if [[ "$has_more_reviews" == "true" ]]; then
        reviews_cursor=$(jq -r '.data.repository.pullRequest.reviews.pageInfo.endCursor' "$TMPDIR/page_${page}.json")
      fi

      echo "    Page $page: $(jq 'length' "$TMPDIR/threads_page.json") threads, $(jq 'length' "$TMPDIR/reviews_page.json") reviews" >&2

      ((page++))

      # Safety limit
      if [[ $page -gt 20 ]]; then
        echo "    Warning: Reached pagination limit (20 pages)" >&2
        break
      fi
    done

    # Extract resolved thread comment IDs (resolved OR outdated)
    jq -r '
      [.[] |
       select(.isResolved == true) |
       .comments.nodes[]?.databaseId] |
      map(select(. != null))
    ' "$all_threads" > "$RESOLVED_FILE" 2>/dev/null || echo "[]" > "$RESOLVED_FILE"

    # Extract outdated thread comment IDs
    jq -r '
      [.[] |
       select(.isOutdated == true) |
       .comments.nodes[]?.databaseId] |
      map(select(. != null))
    ' "$all_threads" > "$OUTDATED_FILE" 2>/dev/null || echo "[]" > "$OUTDATED_FILE"

    # Extract PR reviews (main review bodies with content)
    jq -r '
      [.[] |
       select(.body != null and .body != "") |
       {
         id: .databaseId,
         author: .author.login,
         body: .body,
         state: .state,
         submitted_at: .submittedAt,
         url: .url
       }]
    ' "$all_reviews" > "$PR_REVIEWS_FILE" 2>/dev/null || echo "[]" > "$PR_REVIEWS_FILE"

    local total_threads=$(jq 'length' "$all_threads")
    local resolved_count=$(jq 'length' "$RESOLVED_FILE")
    local outdated_count=$(jq 'length' "$OUTDATED_FILE")
    echo "  Total threads: $total_threads (resolved: $resolved_count, outdated: $outdated_count)" >&2
  }

  fetch_graphql_paginated

  PR_REVIEWS_COUNT=$(jq 'length' "$PR_REVIEWS_FILE")
  echo "  Found $PR_REVIEWS_COUNT PR reviews with body content" >&2
fi

# Filter review comments: only top-level, not resolved, not outdated, not handled
UNRESOLVED_FILE="$TMPDIR/unresolved.json"
if [[ -n "$HANDLED_IDS_FILE" && -f "$HANDLED_IDS_FILE" ]]; then
  jq --slurpfile resolved "$RESOLVED_FILE" --slurpfile outdated "$OUTDATED_FILE" --slurpfile handled "$HANDLED_IDS_FILE" '
    [.[] |
     select(.in_reply_to_id == null) |  # Only top-level comments (not replies)
     select(.id as $id | ($resolved[0] | index($id)) == null) |  # Not resolved
     select(.id as $id | ($outdated[0] | index($id)) == null) |  # Not outdated
     select(.id as $id | ($handled[0] | index($id)) == null) |  # Not already handled
     {
       id: .id,
       author: .user.login,
       file: .path,
       line: (.line // .original_line),
       created_at: .created_at,
       body: .body,
       url: .html_url,
       type: "review_comment"
     }
    ]
  ' "$REVIEW_FILE" > "$UNRESOLVED_FILE"
else
  jq --slurpfile resolved "$RESOLVED_FILE" --slurpfile outdated "$OUTDATED_FILE" '
    [.[] |
     select(.in_reply_to_id == null) |  # Only top-level comments (not replies)
     select(.id as $id | ($resolved[0] | index($id)) == null) |  # Not resolved
     select(.id as $id | ($outdated[0] | index($id)) == null) |  # Not outdated
     {
       id: .id,
       author: .user.login,
       file: .path,
       line: (.line // .original_line),
       created_at: .created_at,
       body: .body,
       url: .html_url,
       type: "review_comment"
     }
    ]
  ' "$REVIEW_FILE" > "$UNRESOLVED_FILE"
fi

# Filter issue comments: only from AI reviewers (Claude, CodeRabbit), not handled
AI_REVIEWS_FILE="$TMPDIR/ai_reviews.json"
if [[ -n "$HANDLED_IDS_FILE" && -f "$HANDLED_IDS_FILE" ]]; then
  jq --slurpfile handled "$HANDLED_IDS_FILE" '
    [.[] |
     select(
       .user.login == "claude[bot]" or
       .user.login == "coderabbitai[bot]"
     ) |
     select(.id as $id | ($handled[0] | index($id)) == null) |  # Not already handled
     {
       id: .id,
       author: .user.login,
       file: null,
       line: null,
       created_at: .created_at,
       body: .body,
       url: .html_url,
       type: "ai_review"
     }
    ]
  ' "$ISSUE_FILE" > "$AI_REVIEWS_FILE"
else
  jq '
    [.[] |
     select(
       .user.login == "claude[bot]" or
       .user.login == "coderabbitai[bot]"
     ) |
     {
       id: .id,
       author: .user.login,
       file: null,
       line: null,
       created_at: .created_at,
       body: .body,
       url: .html_url,
       type: "ai_review"
     }
    ]
  ' "$ISSUE_FILE" > "$AI_REVIEWS_FILE"
fi

# Filter PR reviews: from AI reviewers, not handled
# These are the main review body summaries (e.g., CodeRabbit's full analysis)
FILTERED_PR_REVIEWS_FILE="$TMPDIR/filtered_pr_reviews.json"
if [[ -n "$HANDLED_IDS_FILE" && -f "$HANDLED_IDS_FILE" ]]; then
  jq --slurpfile handled "$HANDLED_IDS_FILE" '
    [.[] |
     select(
       .author == "coderabbitai[bot]" or
       .author == "coderabbitai" or
       .author == "gemini-code-assist[bot]" or
       .author == "gemini-code-assist" or
       .author == "copilot" or
       .author == "copilot-pull-request-reviewer" or
       .author == "greptile-apps" or
       .author == "greptile" or
       .author == "codex" or
       .author == "chatgpt-codex-connector" or
       .author == "claude[bot]"
     ) |
     select(.id as $id | ($handled[0] | index($id)) == null) |  # Not already handled
     . + { type: "pr_review" }
    ]
  ' "$PR_REVIEWS_FILE" > "$FILTERED_PR_REVIEWS_FILE"
else
  jq '
    [.[] |
     select(
       .author == "coderabbitai[bot]" or
       .author == "coderabbitai" or
       .author == "gemini-code-assist[bot]" or
       .author == "gemini-code-assist" or
       .author == "copilot" or
       .author == "copilot-pull-request-reviewer" or
       .author == "greptile-apps" or
       .author == "greptile" or
       .author == "codex" or
       .author == "chatgpt-codex-connector" or
       .author == "claude[bot]"
     ) |
     . + { type: "pr_review" }
    ]
  ' "$PR_REVIEWS_FILE" > "$FILTERED_PR_REVIEWS_FILE"
fi

# Count handled comments if config exists
HANDLED_COUNT=0
if [[ -n "$HANDLED_IDS_FILE" && -f "$HANDLED_IDS_FILE" ]]; then
  HANDLED_COUNT=$(jq 'length' "$HANDLED_IDS_FILE")
fi

# Output result
jq -n \
  --argjson pr "$PR_NUMBER" \
  --arg repo "$REPO" \
  --arg config_file "$CONFIG_FILE" \
  --argjson handled_count "$HANDLED_COUNT" \
  --slurpfile review "$UNRESOLVED_FILE" \
  --slurpfile pr_reviews "$FILTERED_PR_REVIEWS_FILE" \
  --slurpfile ai "$AI_REVIEWS_FILE" \
  '{
    pr_number: $pr,
    repository: $repo,
    fetched_at: (now | todate),
    config_file: $config_file,
    handled_excluded: $handled_count,
    review_comments: {
      count: ($review[0] | length),
      comments: $review[0]
    },
    pr_reviews: {
      count: ($pr_reviews[0] | length),
      description: "Main review body summaries from AI reviewers (CodeRabbit, Gemini, Copilot, etc.)",
      comments: $pr_reviews[0]
    },
    ai_reviews: {
      count: ($ai[0] | length),
      description: "Issue comments from AI reviewers",
      comments: $ai[0]
    },
    total_unresolved: (($review[0] | length) + ($pr_reviews[0] | length) + ($ai[0] | length))
  }'

# Print summary to stderr
REVIEW_COUNT=$(jq 'length' "$UNRESOLVED_FILE")
PR_REVIEW_COUNT=$(jq 'length' "$FILTERED_PR_REVIEWS_FILE")
AI_COUNT=$(jq 'length' "$AI_REVIEWS_FILE")
CLAUDE_COUNT=$(jq '[.[] | select(.author == "claude[bot]")] | length' "$AI_REVIEWS_FILE")
CODERABBIT_COUNT=$(jq '[.[] | select(.author == "coderabbitai[bot]" or .author == "coderabbitai")] | length' "$FILTERED_PR_REVIEWS_FILE")
TOTAL=$((REVIEW_COUNT + PR_REVIEW_COUNT + AI_COUNT))
echo "" >&2
echo "Summary:" >&2
echo "  - Review comments (inline): $REVIEW_COUNT" >&2
echo "  - PR reviews (main body): $PR_REVIEW_COUNT (CodeRabbit: $CODERABBIT_COUNT)" >&2
echo "  - AI issue comments: $AI_COUNT (Claude: $CLAUDE_COUNT)" >&2
echo "  - Total unresolved: $TOTAL" >&2
if [[ "$HANDLED_COUNT" -gt 0 ]]; then
  echo "  - Excluded handled: $HANDLED_COUNT (from $CONFIG_FILE)" >&2
fi
