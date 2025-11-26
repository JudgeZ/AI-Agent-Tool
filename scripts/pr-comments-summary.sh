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
echo "  Unresolved: $(echo "$JSON" | jq -r '.total_unresolved') comments"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# Group by file and show comments
echo "$JSON" | jq -r '
  .comments |
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

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Full JSON: ./scripts/get-unresolved-pr-comments.sh $1"
echo "═══════════════════════════════════════════════════════════════════════"
