#!/usr/bin/env bash
# Regtest helper. Usage:
#   infra/regtest.sh start            compose up, create a bitcoind wallet, mine 101 blocks
#   infra/regtest.sh mine <n>         mine n blocks to the node's own wallet
#   infra/regtest.sh fund <addr> <btc>  send regtest BTC to an address and mine one block
#   infra/regtest.sh height
#   infra/regtest.sh stop             compose down, keep volumes
#   infra/regtest.sh reset            compose down and delete volumes
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE=(docker compose -f "$HERE/compose.yaml")
RPC=(docker compose -f "$HERE/compose.yaml" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password)

wait_rpc() {
  for _ in $(seq 1 60); do
    if "${RPC[@]}" getblockchaininfo >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "bitcoind did not come up" >&2
  exit 1
}

mine() {
  local addr
  addr=$("${RPC[@]}" -rpcwallet=miner getnewaddress)
  "${RPC[@]}" generatetoaddress "$1" "$addr" >/dev/null
  "${RPC[@]}" getblockcount
}

case "${1:-}" in
  start)
    "${COMPOSE[@]}" up -d bitcoind electrs rgb-proxy nostr-relay
    wait_rpc
    "${RPC[@]}" createwallet miner >/dev/null 2>&1 || "${RPC[@]}" loadwallet miner >/dev/null 2>&1 || true
    mine 101
    echo "regtest up: bitcoind 127.0.0.1:${PASSBOOK_BITCOIND_PORT:-18443}, electrs tcp://127.0.0.1:${PASSBOOK_ELECTRS_PORT:-50011}, rgb-proxy http://127.0.0.1:${PASSBOOK_PROXY_PORT:-3010}/json-rpc, relay ws://127.0.0.1:${PASSBOOK_RELAY_PORT:-7777}"
    ;;
  sandbox)
    "${COMPOSE[@]}" up -d --build sandbox
    ;;
  mine)
    mine "${2:-1}"
    ;;
  fund)
    "${RPC[@]}" -rpcwallet=miner sendtoaddress "$2" "$3"
    mine 1
    ;;
  height)
    "${RPC[@]}" getblockcount
    ;;
  stop)
    "${COMPOSE[@]}" down
    ;;
  reset)
    "${COMPOSE[@]}" down -v
    ;;
  *)
    sed -n '2,9p' "$0"
    exit 1
    ;;
esac
