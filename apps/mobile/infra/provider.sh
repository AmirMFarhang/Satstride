#!/usr/bin/env bash
# The laptop as the service provider (M3/M5): platform, a lender peer and the regtest miner, on
# the passbook-mobile stack, with the phone as the borrower. When the phone lends (M6), the
# laptop's seeded borrower (`borrower`) is the counterparty it lends to.
#   provider.sh env            print the environment (source it: eval "$(provider.sh env)")
#   provider.sh seed           wallets for the lenders and the payer, test USDT (npm run seed --fresh)
#   provider.sh platform       the platform API on :4301 (bitcoind chain, signed API, relay order book)
#   provider.sh lender         lender1 as a standalone peer: publish an offer, underwrite one application
#   provider.sh borrower <lender_pk> [usdt]   M6: the laptop's seeded borrower borrows once from that lender
#                              (the phone, when it lends), repays and closes; report in $D/borrower-report.json
#   provider.sh salary <inv> <usdt>   the payer pays the phone's blinded invoice (income history)
#   provider.sh automine       mine a block whenever the mempool is not empty (the phone never mines)
#   provider.sh demo           M5: all of it, fresh: stack, seed (once), platform, miner, lender; prints the dashboard link
#   provider.sh stop           stop the platform/lender/miner started here (stack stays up)
#   provider.sh service up|status|stop|env   M7: the service provider (infra/service-provider.sh: platform,
#                              lender peers negotiating over Nostr, the local scorer check node) on the phone's ports
#   provider.sh service keys   pin the provider's public scorer signer keys (public) into the app, before an APK build
#   provider.sh service reverse  the phone's fixed ports to the service provider (adb reverse, same ports)
#   provider.sh service persona fatima  REGTEST TEST DATA: serve the seeded test persona to the phone once (option A)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../../.."
D="${PASSBOOK_MOBILE_PROVIDER_DIR:-data/mobile/provider}"
[[ "$D" = /* ]] || D="$PWD/$D"
mkdir -p "$D"
: "${COMPOSE_PROJECT_NAME:=passbook-mobile}" "${PASSBOOK_BITCOIND_PORT:=18603}" "${PASSBOOK_ELECTRS_PORT:=50171}" "${PASSBOOK_PROXY_PORT:=3260}" "${PASSBOOK_RELAY_PORT:=7937}"
: "${PASSBOOK_CHAIN:=bitcoind}" "${BITCOIND_URL:=http://127.0.0.1:$PASSBOOK_BITCOIND_PORT}" "${RGB_INDEXER_URL:=tcp://127.0.0.1:$PASSBOOK_ELECTRS_PORT}" "${RGB_TRANSPORT_URL:=rpc://127.0.0.1:$PASSBOOK_PROXY_PORT/json-rpc}"
: "${PASSBOOK_RELAYS:=ws://127.0.0.1:$PASSBOOK_RELAY_PORT}" "${PORT:=${PASSBOOK_PLATFORM_PORT:-4301}}" "${PASSBOOK_URL:=http://127.0.0.1:$PORT}"
: "${PASSBOOK_WALLETS:=$D/wallets}" "${PASSBOOK_STATE:=$D/state.json}" "${PASSBOOK_DB:=$D/platform.db}"
export COMPOSE_PROJECT_NAME PASSBOOK_BITCOIND_PORT PASSBOOK_ELECTRS_PORT PASSBOOK_PROXY_PORT PASSBOOK_RELAY_PORT PASSBOOK_CHAIN BITCOIND_URL RGB_INDEXER_URL RGB_TRANSPORT_URL PASSBOOK_RELAYS PORT PASSBOOK_URL PASSBOOK_WALLETS PASSBOOK_STATE PASSBOOK_DB
envs() {
  local name
  for name in COMPOSE_PROJECT_NAME PASSBOOK_BITCOIND_PORT PASSBOOK_ELECTRS_PORT PASSBOOK_PROXY_PORT PASSBOOK_RELAY_PORT PASSBOOK_CHAIN BITCOIND_URL RGB_INDEXER_URL RGB_TRANSPORT_URL PASSBOOK_RELAYS PORT PASSBOOK_URL PASSBOOK_WALLETS PASSBOOK_STATE PASSBOOK_DB; do
    printf 'export %s=%q\n' "$name" "${!name}"
  done
}
# only processes this script started (their own process groups, recorded in $D/<name>.pid);
# stop waits for each to exit (infra/proc.sh)
. "$HERE/proc.sh"
case "${1:-}" in
  env) envs ;;
  seed) npm run seed -- --fresh ;;
  platform) start platform npx tsx src/server/main.ts; echo "platform starting on :$PORT (log $D/platform.log)" ;;
  lender)
    asset=$(node -p "require('$PASSBOOK_STATE').asset.id")
    start lender npx tsx src/cli/peer.ts --role lender --wallet lender1 --asset-id "$asset" --policy history --auto-approve --timeout-ms 900000 --output "$D/lender-report.json"
    echo "lender1 peer started (log $D/lender.log)" ;;
  borrower)
    start borrower npx tsx src/cli/peer.ts --role borrower --lender-pk "${2:?lender pubkey, the passbook key of the phone}" --principal "${3:-100}" --auto-approve --timeout-ms 1800000 --output "$D/borrower-report.json"
    echo "the laptop borrower peer started, borrowing ${3:-100} test USDT from ${2:0:12} (log $D/borrower.log)" ;;
  salary) npx tsx apps/mobile/infra/salary.ts "${2:?invoice}" "${3:?usdt}" ;;
  automine)
    start automine bash -c 'while true; do n=$(curl -s --user user:password -H "content-type: text/plain" --data "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"getmempoolinfo\",\"params\":[]}" '"$BITCOIND_URL"' | python3 -c "import json,sys; print(json.load(sys.stdin)[\"result\"][\"size\"])" 2>/dev/null || echo 0); if [ "${n:-0}" -gt 0 ]; then a=$(curl -s --user user:password --data "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"getnewaddress\",\"params\":[]}" '"$BITCOIND_URL"'/wallet/miner | python3 -c "import json,sys; print(json.load(sys.stdin)[\"result\"])"); curl -s --user user:password --data "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"generatetoaddress\",\"params\":[1,\"$a\"]}" '"$BITCOIND_URL"'/wallet/miner > /dev/null; fi; sleep 3; done'
    echo "automine on (a block when the mempool has transactions)" ;;
  demo)
    ALL=1 apps/mobile/infra/regtest.sh up >/dev/null
    [ -f "$PASSBOOK_STATE" ] || npm run seed -- --fresh
    stop lender && stop platform   # each waits for its process to exit before the database moves
    # a fresh platform and event log: the dashboard follows the first borrower it sees (the phone).
    # The previous database is kept beside it, renamed, as evidence.
    if [ -f "$PASSBOOK_DB" ]; then
      keep="${PASSBOOK_DB%.db}-$(date +%Y%m%d-%H%M%S).db"
      # the stopped platform's -wal/-shm may vanish as it exits
      for x in "" -wal -shm; do mv "$PASSBOOK_DB$x" "$keep$x" 2>/dev/null || true; done
      echo "previous platform database kept as $keep"
    fi
    start platform npx tsx src/server/main.ts
    for _ in $(seq 60); do curl -sf "$PASSBOOK_URL/state" >/dev/null && break; sleep 1; done
    [ -f "$D/automine.pid" ] && kill -0 "$(cat "$D/automine.pid")" 2>/dev/null || "$0" automine
    "$0" lender
    echo "dashboard (operator link, private): $(grep -o "http://127.0.0.1:$PORT/#session=[0-9a-f.]*" "$D/platform.log" | tail -1)"
    echo "phone: for p in $PASSBOOK_ELECTRS_PORT $PASSBOOK_PROXY_PORT $PORT $PASSBOOK_RELAY_PORT; do adb reverse tcp:\$p tcp:\$p; done" ;;
  stop) for n in automine lender borrower platform; do stop "$n"; done ;;
  service)
    # M7: the laptop is only the service provider. infra/service-provider.sh (P2) owns the stack; this passes it
    # the phone's ports and its own state directory, and never deletes volumes (its stop keeps them).
    SP=infra/service-provider.sh
    [ -x "$SP" ] || { echo "$SP is not in this checkout yet (it lands with the provider credit-check work)" >&2; exit 3; }
    export PASSBOOK_SP_PROJECT="${PASSBOOK_SP_PROJECT:-passbook-mobile-sp}" PASSBOOK_SP_STATE="${PASSBOOK_SP_STATE:-$PWD/data/mobile/service-provider}"
    # the phone's build reads fixed ports (the passbook-mobile reservation): the provider takes those, so stop
    # the M3-M6 stack first (provider.sh stop; regtest.sh down keeps volumes); service-provider.sh refuses taken ports
    export PASSBOOK_SP_BITCOIND_PORT=18603 PASSBOOK_SP_ELECTRS_PORT=50171 PASSBOOK_SP_PROXY_PORT=3260 PASSBOOK_SP_RELAY_PORT=7937 PASSBOOK_SP_PLATFORM_PORT=4301
    export PASSBOOK_SP_PUBLIC_HOST=127.0.0.1 PASSBOOK_SP_SUBNET="${PASSBOOK_SP_SUBNET:-10.231.71.0/24}"
    case "${2:-}" in
      up|status|stop|env) exec "$SP" "$2" "${@:3}" ;;
      keys)
        keys="${PASSBOOK_SCORER_KEYS_FILE:-$PASSBOOK_SP_STATE/provider.json}"
        [ -f "$keys" ] || { echo "no public scorer signer configuration: $keys" >&2; exit 1; }
        python3 - "$keys" apps/mobile/src/app/scorer-keys.json <<'PYCODE'
import json, re, sys
src = json.load(open(sys.argv[1]))
if isinstance(src, dict) and src.get('kind') == 'passbook-service-provider':
    src = (src.get('scorer') or {}).get('evidence_keys') or []
rows = src if isinstance(src, list) else src.get('keys', [])
keep = []
for row in rows:
    key = row.get('public_key_hex')
    if not isinstance(key, str) or not re.fullmatch('[0-9a-f]{64}', key):
        raise SystemExit('invalid public scorer key')
    if row.get('development'):
        raise SystemExit('development signer cannot be pinned in the phone build')
    keep.append({'public_key_hex': key})
if not keep:
    raise SystemExit('no public scorer keys: refusing to produce a build that trusts no scorer')
with open(sys.argv[2], 'w') as f:
    json.dump({'keys': keep}, f, indent=2)
    f.write('\n')
print(f"pinned {len(keep)} public scorer signer(s) into {sys.argv[2]}")
PYCODE
        ;;
      reverse)
        # the service provider runs on the phone's own fixed ports, so each maps to itself
        for p in "$PASSBOOK_SP_ELECTRS_PORT" "$PASSBOOK_SP_PROXY_PORT" "$PASSBOOK_SP_PLATFORM_PORT" "$PASSBOOK_SP_RELAY_PORT"; do adb reverse "tcp:$p" "tcp:$p"; done
        echo "phone -> service provider on electrs $PASSBOOK_SP_ELECTRS_PORT, rgb proxy $PASSBOOK_SP_PROXY_PORT, platform $PASSBOOK_SP_PLATFORM_PORT, relay $PASSBOOK_SP_RELAY_PORT" ;;
      persona)
        # REGTEST TEST DATA ONLY (the user's option A): the seeded persona's words, rgb-lib backup, seeded
        # income records and the observer's history proof as issued, served ONCE to the phone over USB
        # (adb reverse on its loopback), then the mapping is removed. The phone labels it a test persona.
        name="${3:-fatima}"
        case "$name" in fatima|walter) ;; *) echo "usage: provider.sh service persona fatima|walter" >&2; exit 2 ;; esac
        eval "$("$SP" env)"
        proof="$PASSBOOK_SP_STATE/persona-$name-proof.json" out="$PASSBOOK_SP_STATE/persona-$name.json"
        npx tsx infra/service-provider-history-proof.ts --persona "$name" --out "$proof"
        npx tsx apps/mobile/infra/persona-package.ts --persona "$name" --proof "$proof" --out "$out"
        port=4309
        adb reverse "tcp:$port" "tcp:$port"
        echo "serving the test persona $name once on 127.0.0.1:$port (the phone: Settings, Use the seeded test persona)"
        python3 - "$out" "$port" <<'PY'
import http.server, sys
body = open(sys.argv[1], 'rb').read()
class One(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/persona.json':
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(body))); self.end_headers()
        self.wfile.write(body); self.server.served = True
    def log_message(self, *a): pass
s = http.server.HTTPServer(('127.0.0.1', int(sys.argv[2])), One); s.served = False; s.timeout = 900
while not s.served:
    s.handle_request()
print('served once')
PY
        adb reverse --remove "tcp:$port" || true ;;
      *) echo "usage: provider.sh service up|status|stop|env|keys|reverse|persona" >&2; exit 2 ;;
    esac ;;
  *) sed -n '2,18p' "$0"; exit 2 ;;
esac
