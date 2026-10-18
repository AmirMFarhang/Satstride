#!/usr/bin/env bash
# Laptop side of the on-device wallet demo, against the passbook-mobile regtest stack
# (infra/compose.yaml with COMPOSE_PROJECT_NAME=passbook-mobile). Regtest only.
#   regtest.sh up                    start bitcoind + electrs (+ proxy, relay with ALL=1)
#   regtest.sh reverse               adb reverse the stack's ports onto the phone (USB)
#   regtest.sh fund <bcrt1…> [btc]   send test BTC from the node's wallet to the phone, mine 1 block
#   regtest.sh mine [n]              mine n blocks (default 1)
#   regtest.sh tx <txid>             show a transaction as the node sees it (confirmations, outputs)
#   regtest.sh stop                  stop the stack (volumes kept), remove this demo's adb reverse rules
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${COMPOSE_PROJECT_NAME:=passbook-mobile}" "${PASSBOOK_BITCOIND_PORT:=18603}" "${PASSBOOK_ELECTRS_PORT:=50171}" "${PASSBOOK_PROXY_PORT:=3260}" "${PASSBOOK_RELAY_PORT:=7937}"
export COMPOSE_PROJECT_NAME PASSBOOK_BITCOIND_PORT PASSBOOK_ELECTRS_PORT PASSBOOK_PROXY_PORT PASSBOOK_RELAY_PORT
PORTS="${MOBILE_REVERSE_PORTS:-$PASSBOOK_ELECTRS_PORT $PASSBOOK_PROXY_PORT $PASSBOOK_RELAY_PORT $PASSBOOK_BITCOIND_PORT ${PASSBOOK_PLATFORM_PORT:-4301}}"
cli() { docker compose -f infra/compose.yaml exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password "$@"; }
wallet() { cli listwallets | grep -q '"miner"' || cli loadwallet miner >/dev/null 2>&1 || cli createwallet miner >/dev/null; }
mine() { wallet; cli -rpcwallet=miner generatetoaddress "${1:-1}" "$(cli -rpcwallet=miner getnewaddress)" >/dev/null; echo "height $(cli getblockcount)"; }
case "${1:-}" in
  up)
    svc="bitcoind electrs"; [ "${ALL:-0}" = 1 ] && svc="$svc rgb-proxy nostr-relay"
    docker compose -f infra/compose.yaml up -d $svc
    for _ in $(seq 30); do cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
    wallet
    [ "$(cli getblockcount)" -ge 101 ] || mine 101 ;;
  reverse)
    for p in $PORTS; do adb reverse "tcp:$p" "tcp:$p" >/dev/null; done
    adb reverse --list ;;
  fund)
    addr="${2:?usage: fund <bcrt1 address> [btc]}"
    case "$addr" in bcrt1*) ;; *) echo "refusing: $addr is not a regtest address" >&2; exit 1 ;; esac
    wallet
    txid=$(cli -rpcwallet=miner sendtoaddress "$addr" "${3:-0.5}")
    echo "sent ${3:-0.5} test BTC to $addr: $txid"
    mine 1 ;;
  mine) mine "${2:-1}" ;;
  tx) cli getrawtransaction "${2:?txid}" true | python3 -c 'import json,sys; t=json.load(sys.stdin); print(json.dumps({"txid":t["txid"],"confirmations":t.get("confirmations",0),"vout":[{"value":o["value"],"address":o["scriptPubKey"].get("address")} for o in t["vout"]]},indent=1))' ;;
  stop)
    for p in $PORTS; do adb reverse --remove "tcp:$p" >/dev/null 2>&1 || true; done
    docker compose -f infra/compose.yaml stop ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
