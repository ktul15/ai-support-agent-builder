#!/usr/bin/env bash
#
# board.sh — move a GitHub issue's card on Projects v2 board #9.
#
# Usage:
#   scripts/board.sh todo         <issue-number>
#   scripts/board.sh in-progress  <issue-number>
#   scripts/board.sh done         <issue-number>   # also closes the issue
#
# Requires: gh (authenticated as an account with `project` scope), python3.

set -euo pipefail

OWNER="ktul15"
PROJECT="9"
REPO="ktul15/ai-support-agent-builder"

usage() { echo "Usage: $0 <todo|in-progress|done> <issue-number>" >&2; exit 1; }
[ "$#" -eq 2 ] || usage
STATUS="$1"; ISSUE="$2"
case "$STATUS" in
  todo)        WANT="Todo" ;;
  in-progress) WANT="In Progress" ;;
  done)        WANT="Done" ;;
  *)           usage ;;
esac
[[ "$ISSUE" =~ ^[0-9]+$ ]] || usage

# Project node id (needed by item-edit)
PID="$(gh project view "$PROJECT" --owner "$OWNER" --format json \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")"

# Status field id + the option id matching the desired status name
read -r FIELD_ID OPT_ID < <(gh project field-list "$PROJECT" --owner "$OWNER" --format json \
  | python3 -c "
import sys,json
want='''$WANT'''
for f in json.load(sys.stdin)['fields']:
    if f.get('name')=='Status':
        for o in f.get('options',[]):
            if o['name']==want:
                print(f['id'], o['id']); sys.exit()
")
[ -n "${OPT_ID:-}" ] || { echo "Status option '$WANT' not found on board" >&2; exit 1; }

# Resolve the project item id for this issue number
ITEM="$(gh project item-list "$PROJECT" --owner "$OWNER" --format json --limit 200 \
  | python3 -c "
import sys,json
issue=int('$ISSUE')
for i in json.load(sys.stdin)['items']:
    if i.get('content',{}).get('number')==issue:
        print(i['id']); break
")"
[ -n "$ITEM" ] || { echo "Issue #$ISSUE is not on project board #$PROJECT" >&2; exit 1; }

gh project item-edit --id "$ITEM" --project-id "$PID" \
  --field-id "$FIELD_ID" --single-select-option-id "$OPT_ID" >/dev/null
echo "Issue #$ISSUE -> $WANT"

if [ "$STATUS" = "done" ]; then
  gh issue close "$ISSUE" --repo "$REPO" >/dev/null 2>&1 || true
  echo "Issue #$ISSUE closed"
fi
