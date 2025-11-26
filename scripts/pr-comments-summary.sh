#!/usr/bin/env bash
#
# Show a human-readable summary of unresolved PR comments
#
# Usage:
#   ./scripts/pr-comments-summary.sh <pr_number> [owner/repo]
#
# Examples:
#   ./scripts/pr-comments-summary.sh 36
#   ./scripts/pr-comments-summary.sh 36 JudgeZ/AI-Agent-Tool
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Get the raw JSON
JSON=$("$SCRIPT_DIR/get-unresolved-pr-comments.sh" "$@" 2>/dev/null)

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  PR #$(echo "$JSON" | jq -r '.pr_number') - $(echo "$JSON" | jq -r '.repository')"
echo "  Fetched: $(echo "$JSON" | jq -r '.fetched_at')"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# Show review comments (code comments)
echo "┌─────────────────────────────────────────────────────────────────────┐"
echo "│  REVIEW COMMENTS (Code Comments)                                    │"
echo "└─────────────────────────────────────────────────────────────────────┘"
echo ""

REVIEW_TOTAL=$(echo "$JSON" | jq '.review_comments.total')
REVIEW_UNRESOLVED=$(echo "$JSON" | jq '.review_comments.unresolved')

echo "Total: $REVIEW_TOTAL | Top-level (unresolved): $REVIEW_UNRESOLVED"
echo ""

# Group by file
echo "$JSON" | jq -r '
  .review_comments.comments |
  group_by(.file) |
  .[] |
  "📁 \(.[0].file // "unknown")\n" +
  (
    [.[] | select(.in_reply_to == null)] |
    if length == 0 then "   (no top-level comments)\n"
    else
      .[] |
      "   ├─ Line \(.line // "?"): @\(.author)\n" +
      "   │  \(.body | split("\n")[0] | if length > 70 then .[:70] + "..." else . end)\n"
    end
  )
'

echo ""
echo "┌─────────────────────────────────────────────────────────────────────┐"
echo "│  ISSUE COMMENTS (PR Discussion)                                     │"
echo "└─────────────────────────────────────────────────────────────────────┘"
echo ""

ISSUE_TOTAL=$(echo "$JSON" | jq '.issue_comments.total')
echo "Total: $ISSUE_TOTAL"
echo ""

echo "$JSON" | jq -r '
  .issue_comments.comments[] |
  "💬 @\(.author) (\(.created_at | split("T")[0]))\n" +
  "   \(.body | split("\n")[0] | if length > 70 then .[:70] + "..." else . end)\n"
'

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Use './scripts/get-unresolved-pr-comments.sh $1' for full JSON output"
echo "═══════════════════════════════════════════════════════════════════════"
