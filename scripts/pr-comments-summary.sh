#!/usr/bin/env bash
#
# Show a human-readable summary of unresolved PR review comments
#
# Usage:
#   ./scripts/pr-comments-summary.sh <pr_number> [owner/repo]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Get the raw JSON
JSON=$("$SCRIPT_DIR/get-unresolved-pr-comments.sh" "$@" 2>/dev/null)

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  PR #$(echo "$JSON" | jq -r '.pr_number') - $(echo "$JSON" | jq -r '.repository')"
echo "  Fetched: $(echo "$JSON" | jq -r '.fetched_at')"
echo "  Unresolved: $(echo "$JSON" | jq -r '.review_comments.count + .ai_reviews.count') comments"
echo "  (Review: $(echo "$JSON" | jq -r '.review_comments.count'), AI: $(echo "$JSON" | jq -r '.ai_reviews.count'))"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# Group by file and show review comments
echo "$JSON" | jq -r '
  .review_comments.comments |
  group_by(.file) |
  .[] |
  "\n📁 \(.[0].file)\n" +
  "────────────────────────────────────────────────────────────────────────\n" +
  (
    .[] |
    "  Line \(.line // "?"): @\(.author)\n" +
    "  \(.body | split("\n")[0] | if length > 72 then .[:72] + "..." else . end)\n"
  )
'

# Show AI review summaries if any
AI_COUNT=$(echo "$JSON" | jq -r '.ai_reviews.count')
if [[ "$AI_COUNT" -gt 0 ]]; then
  echo ""
  echo "🤖 AI Review Summaries ($AI_COUNT)"
  echo "────────────────────────────────────────────────────────────────────────"
  echo "$JSON" | jq -r '
    .ai_reviews.comments[] |
    "  @\(.author): \(.body | split("\n")[0] | if length > 60 then .[:60] + "..." else . end)"
  '
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Full JSON: ./scripts/get-unresolved-pr-comments.sh $1"
echo "═══════════════════════════════════════════════════════════════════════"
