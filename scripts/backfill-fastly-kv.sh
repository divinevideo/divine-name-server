#!/usr/bin/env bash
set -euo pipefail

# Backfill Fastly KV Store from D1 via the paginated admin sync endpoint.
# Usage:
#   ./scripts/backfill-fastly-kv.sh --dry-run          # report what would sync
#   ./scripts/backfill-fastly-kv.sh --apply             # sync for real
#   ./scripts/backfill-fastly-kv.sh --apply --limit=1000

API_BASE="${API_BASE:-https://names.admin.divine.video}"
LIMIT=500
MODE=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)  MODE="dry_run" ;;
    --apply)    MODE="apply" ;;
    --limit=*)  LIMIT="${arg#--limit=}" ;;
    *)          echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Usage: $0 --dry-run | --apply [--limit=N]"
  echo ""
  echo "  --dry-run   Report what would be synced (no Fastly writes)"
  echo "  --apply     Sync active usernames to Fastly KV"
  echo "  --limit=N   Page size (default 500, max 1000)"
  exit 1
fi

if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  echo "Error: ADMIN_TOKEN env var required"
  echo "  Extract from browser: copy the 'session' cookie value from names.admin.divine.video"
  exit 1
fi

DRY_RUN="false"
[[ "$MODE" == "dry_run" ]] && DRY_RUN="true"

cursor="null"
page=0
total_synced=0
total_failed=0
total_skipped=0

echo "Backfill Fastly KV — mode=$MODE limit=$LIMIT base=$API_BASE"
echo ""

while true; do
  page=$((page + 1))

  if [[ "$cursor" == "null" ]]; then
    payload="{\"limit\":$LIMIT,\"dry_run\":$DRY_RUN}"
  else
    payload="{\"limit\":$LIMIT,\"cursor\":\"$cursor\",\"dry_run\":$DRY_RUN}"
  fi

  response=$(curl -s -w "\n%{http_code}" \
    -X POST "$API_BASE/api/admin/sync/fastly" \
    -H "Content-Type: application/json" \
    -H "Cookie: __session=$ADMIN_TOKEN" \
    -d "$payload")

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" != "200" ]]; then
    echo "ERROR: HTTP $http_code on page $page"
    echo "$body"
    exit 1
  fi

  ok=$(echo "$body" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "ERROR: API returned ok=false on page $page"
    echo "$body" | jq .
    exit 1
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    syncable=$(echo "$body" | jq -r '.syncable')
    skipped=$(echo "$body" | jq -r '.skipped')
    remaining=$(echo "$body" | jq -r '.remaining // 0')
    cursor=$(echo "$body" | jq -r '.cursor // "null"')
    total_synced=$((total_synced + syncable))
    total_skipped=$((total_skipped + skipped))
    echo "Page $page: $syncable syncable, $skipped skipped (no pubkey), $remaining remaining"
  else
    synced=$(echo "$body" | jq -r '.synced')
    failed=$(echo "$body" | jq -r '.failed')
    remaining=$(echo "$body" | jq -r '.remaining // 0')
    cursor=$(echo "$body" | jq -r '.cursor // "null"')
    total_synced=$((total_synced + synced))
    total_failed=$((total_failed + failed))
    echo "Page $page: $synced synced, $failed failed, $remaining remaining"

    errors=$(echo "$body" | jq -r '.errors // [] | .[]')
    if [[ -n "$errors" ]]; then
      echo "  Errors: $errors"
    fi
  fi

  if [[ "$cursor" == "null" ]]; then
    break
  fi
done

echo ""
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete: $total_synced would sync, $total_skipped would skip ($page pages)"
else
  echo "Backfill complete: $total_synced synced, $total_failed failed ($page pages)"
fi
