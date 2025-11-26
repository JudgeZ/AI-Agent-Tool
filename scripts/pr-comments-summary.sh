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
echo "  Total Unresolved: $(echo "$JSON" | jq -r '.total_unresolved // (.review_comments.count + .ai_reviews.count + (.pr_reviews.count // 0))')"
echo "    - Inline review comments: $(echo "$JSON" | jq -r '.review_comments.count')"
echo "    - PR review bodies: $(echo "$JSON" | jq -r '.pr_reviews.count // 0')"
echo "    - AI issue comments: $(echo "$JSON" | jq -r '.ai_reviews.count')"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# Show PR review summaries (main review bodies from CodeRabbit, Gemini, etc.)
PR_REVIEW_COUNT=$(echo "$JSON" | jq -r '.pr_reviews.count // 0')
if [[ "$PR_REVIEW_COUNT" -gt 0 ]]; then
  echo ""
  echo "📋 PR Review Bodies ($PR_REVIEW_COUNT) - Full AI analysis summaries"
  echo "────────────────────────────────────────────────────────────────────────"
  echo "$JSON" | jq -r '
    .pr_reviews.comments[]? |
    "\n  🔍 @\(.author) [\(.state)]:\n" +
    "  \(.body | split("\n") | .[0:5] | join("\n  "))" +
    (if (.body | split("\n") | length) > 5 then "\n  ... (truncated, \((.body | split("\n") | length) - 5) more lines)" else "" end)
  '
  echo ""
fi

# Group by file and show inline review comments
REVIEW_COUNT=$(echo "$JSON" | jq -r '.review_comments.count')
if [[ "$REVIEW_COUNT" -gt 0 ]]; then
  echo ""
  echo "📁 Inline Review Comments ($REVIEW_COUNT)"
  echo "────────────────────────────────────────────────────────────────────────"
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
fi

# Show AI issue comment summaries if any
AI_COUNT=$(echo "$JSON" | jq -r '.ai_reviews.count')
if [[ "$AI_COUNT" -gt 0 ]]; then
  echo ""
  echo "🤖 AI Issue Comments ($AI_COUNT)"
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
