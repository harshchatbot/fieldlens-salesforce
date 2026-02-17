#!/usr/bin/env bash
set -euo pipefail

WORKDIR="/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce"
REPORT_DIR="$WORKDIR/reports"
mkdir -p "$REPORT_DIR"

ts="$(date +%Y%m%d-%H%M%S)"
report="$REPORT_DIR/fieldlens-smoke-$ts.md"

ask_result() {
  local key="$1"
  local desc="$2"
  local result note

  echo
  echo "[$key] $desc"
  echo "  Enter result: p=PASS, f=FAIL, n=NOT_TESTED"
  read -r -p "  Result [p/f/n]: " result
  case "${result,,}" in
    p) result="PASS" ;;
    f) result="FAIL" ;;
    n|"") result="NOT_TESTED" ;;
    *) result="NOT_TESTED" ;;
  esac

  read -r -p "  Notes (optional): " note
  RESULTS+=("$key|$desc|$result|$note")
}

RESULTS=()

cat <<'BANNER'
FieldLens Salesforce Sandbox Smoke Test
This runner creates a markdown report under /reports.
BANNER

echo
read -r -p "Sandbox domain (e.g. mydomain--full.sandbox.my.salesforce.com): " sf_domain
read -r -p "Object API Name for setup test [Account]: " object_api
object_api="${object_api:-Account}"
read -r -p "Field API Name for setup test [Custom_Status__c]: " field_api
field_api="${field_api:-Custom_Status__c}"
read -r -p "Record Id for record-page test (optional): " record_id

setup_url="https://$sf_domain/lightning/setup/ObjectManager/$object_api/FieldsAndRelationships/$field_api/view"
record_url=""
if [[ -n "$record_id" ]]; then
  record_url="https://$sf_domain/lightning/r/$object_api/$record_id/view"
fi

cat <<EOF2

Manual navigation URLs:
- Setup field page: $setup_url
- Record page: ${record_url:-"(provide record id to generate)"}

Run each test step in Chrome, then enter result here.
EOF2

ask_result "SETUP_DETECT" "Field page context auto-detected (object + field displayed in panel header)"
ask_result "SETUP_SCAN" "Run Impact Scan works on setup field page"
ask_result "SETUP_GROUPS" "Grouped categories shown with counts (Validation Rules, Apex Classes, Apex Triggers, Flows)"
ask_result "SETUP_LINKS" "Result links open expected Salesforce setup pages in new tab"
ask_result "RECORD_FIELDS" "Record page loads field list (label + API name + data type)"
ask_result "RECORD_SEARCH" "Field search works and is responsive"
ask_result "RECORD_SCAN" "Run Impact Scan works for selected field from dropdown"
ask_result "COPY_SUMMARY" "Copy Summary button copies markdown output"
ask_result "ESC_CLOSE" "Escape key closes the slide-in panel"
ask_result "CACHE_10MIN" "Repeat same scan within 10 minutes returns quickly (cache behavior)"
ask_result "NO_IMPACT" "No references case clearly shows 'No impact found'"
ask_result "PERMISSION_ERROR" "Insufficient permission/API errors are surfaced with clear messages"
ask_result "SPA_NAV" "Lightning SPA navigation updates context without full page refresh"

{
  echo "# FieldLens Smoke Test Report"
  echo
  echo "- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Sandbox: $sf_domain"
  echo "- Setup Object: $object_api"
  echo "- Setup Field: $field_api"
  echo "- Record Id: ${record_id:-N/A}"
  echo
  echo "## URLs"
  echo "- Setup: $setup_url"
  echo "- Record: ${record_url:-N/A}"
  echo
  echo "## Results"
  echo "| Test Key | Description | Result | Notes |"
  echo "|---|---|---|---|"

  pass=0
  fail=0
  na=0

  for row in "${RESULTS[@]}"; do
    IFS='|' read -r key desc result note <<<"$row"
    safe_note="${note//|/\/}"
    echo "| $key | $desc | $result | $safe_note |"

    case "$result" in
      PASS) pass=$((pass + 1)) ;;
      FAIL) fail=$((fail + 1)) ;;
      *) na=$((na + 1)) ;;
    esac
  done

  echo
  echo "## Summary"
  echo "- PASS: $pass"
  echo "- FAIL: $fail"
  echo "- NOT_TESTED: $na"
} > "$report"

echo
echo "Report written: $report"
if command -v open >/dev/null 2>&1; then
  echo "Tip: open \"$report\""
fi
