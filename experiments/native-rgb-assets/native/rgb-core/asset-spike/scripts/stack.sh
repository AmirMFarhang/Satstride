#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
export PASSBOOK_BITCOIND_PORT=18743 PASSBOOK_ELECTRS_PORT=50301 PASSBOOK_PROXY_PORT=3400
COMPOSE=(docker compose -p passbook-onchain-assets -f "$ROOT/infra/compose.yaml")
case "${1:-}" in
  start)
    "${COMPOSE[@]}" up -d bitcoind electrs rgb-proxy
    for _ in $(seq 1 60); do
      if "${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password getblockchaininfo >/dev/null 2>&1; then break; fi
      sleep 1
    done
    "${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password createwallet miner >/dev/null 2>&1 || \
      "${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password loadwallet miner >/dev/null
    HEIGHT=$("${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password getblockcount)
    if (( HEIGHT < 111 )); then
      ADDRESS=$("${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password -rpcwallet=miner getnewaddress)
      "${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password -rpcwallet=miner generatetoaddress 111 "$ADDRESS" >/dev/null
    fi
    ;;
  stop) "${COMPOSE[@]}" stop bitcoind electrs rgb-proxy ;;
  *) echo 'Usage: native/rgb-core/asset-spike/scripts/stack.sh start|stop' >&2; exit 1 ;;
esac
