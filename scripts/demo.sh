#!/usr/bin/env bash
# Drive the DataFund flow from the terminal, signing with keys in ~/.near-credentials (near-cli legacy keychain).
# Every step shows up live in the web UI.
#
#   scripts/demo.sh chip-in   <account> <near>
#   scripts/demo.sh propose   <account> <title> <labels a|b> <reward-near> [slots] [min-rows]
#   scripts/demo.sh approve   <council-account> <proposal-id>
#   scripts/demo.sh reject    <council-account> <proposal-id>
#   scripts/demo.sh claim     <account> <bounty-id>
#   scripts/demo.sh submit    <account> <bounty-id> <file.jsonl>
#   scripts/demo.sh status    [account]
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
DAO=${DAO_ID:?set DAO_ID in .env}
NET=${NEAR_NETWORK:-testnet}
API=${PUBLIC_URL:-http://localhost:8787}
NEAR=${NEAR_BIN:-$(command -v near || echo "npx near")}

call() { # signer method json-args deposit
  $NEAR contract call-function as-transaction "$DAO" "$2" json-args "$3" prepaid-gas '200 Tgas' \
    attached-deposit "$4" sign-as "$1" network-config "$NET" sign-with-legacy-keychain send 2>&1 |
    grep -E "succeeded|panicked|ERR_|Error|transactions/" | sed 's/\x1b\[[0-9;]*m//g'
}
view() { $NEAR contract call-function as-read-only "$DAO" "$1" json-args "${2:-{\}}" network-config "$NET" now 2>/dev/null | sed -n '/^[\[{0-9"]/,$p'; }
json() { python3 -c "$1" "${@:2}"; }

cmd=${1:-help}; shift || true
case "$cmd" in
  chip-in)
    $NEAR tokens "$1" send-near "$DAO" "$2 NEAR" network-config "$NET" sign-with-legacy-keychain send 2>&1 | grep -E "transferred|Error" ;;
  propose)
    args=$(json 'import json,sys
t,labels,reward=sys.argv[1:4]; slots=int(sys.argv[4]); minrows=int(sys.argv[5])
spec={"title":t,"format":"jsonl","fields":{"text":"string","label":labels},"minRows":minrows,
      "guidelines":"Realistic examples, no real personal data, roughly balanced labels."}
yocto=str(int(round(float(reward)*1000))*10**21)
print(json.dumps({"proposal":{"description":"New dataset bounty: "+t,"kind":{"AddBounty":{"bounty":{
  "description":json.dumps(spec),"token":"","amount":yocto,"times":slots,"max_deadline":str(48*3600*10**9)}}}}}))' \
      "$2" "$3" "$4" "${5:-3}" "${6:-20}")
    call "$1" add_proposal "$args" '0 NEAR'
    echo "proposal id: $(( $(view get_last_proposal_id) - 1 ))" ;;
  approve|reject)
    kind=$(view get_proposal "{\"id\":$2}" | json 'import json,sys;print(json.dumps(json.load(sys.stdin)["kind"]))')
    action=$([ "$cmd" = approve ] && echo VoteApprove || echo VoteReject)
    call "$1" act_proposal "{\"id\":$2,\"action\":\"$action\",\"proposal\":$kind}" '0 NEAR' ;;
  claim)
    bond=$(view get_policy | json 'import json,sys;print(json.load(sys.stdin)["bounty_bond"])')
    near_bond=$(json 'import sys;print(int(sys.argv[1])/10**24)' "$bond")
    deadline=$(view get_bounties '{"from_index":0,"limit":100}' | json 'import json,sys;print([b for b in json.load(sys.stdin) if b["id"]==int(sys.argv[1])][0]["max_deadline"])' "$2")
    call "$1" bounty_claim "{\"id\":$2,\"deadline\":\"$deadline\"}" "$near_bond NEAR" ;;
  submit)
    up=$(json 'import json,sys;print(json.dumps({"content":open(sys.argv[1]).read(),"format":"jsonl"}))' "$3" |
      curl -sf -X POST "$API/api/upload" -H 'content-type: application/json' -d @-)
    desc=$(json 'import json,sys;u=json.loads(sys.argv[1]);print(json.dumps({"id":int(sys.argv[2]),"description":json.dumps({"url":u["url"],"sha256":u["sha256"]})}))' "$up" "$2")
    echo "uploaded: $up"
    call "$1" bounty_done "$desc" '0 NEAR'
    echo "payout proposal id: $(( $(view get_last_proposal_id) - 1 )). The verifier votes within ~10s; watch the UI." ;;
  status)
    echo "treasury available: $(view get_available_amount | json 'import sys;print(int(sys.stdin.read().strip().strip(chr(34)))/10**24)') NEAR"
    view get_bounties '{"from_index":0,"limit":100}' | json 'import json,sys
for b in json.load(sys.stdin):
  t=json.loads(b["description"]).get("title","?") if b["description"].startswith("{") else b["description"]
  print("bounty #%d: %s | %s NEAR x %d slots" % (b["id"], t, int(b["amount"])/10**24, b["times"]))'
    if [ -n "${1:-}" ]; then
      $NEAR account view-account-summary "$1" network-config "$NET" now 2>&1 | grep -i "native account balance" | tr -s ' ' || echo "$1: not found"
    fi ;;
  *) sed -n '2,12p' "$0" ;;
esac
