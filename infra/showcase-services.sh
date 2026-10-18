#!/usr/bin/env bash
# Starts only this showcase's selected project; never resets chains or wallets.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${COMPOSE_PROJECT_NAME:?Set the showcase Compose project}"
COMPOSE=(docker compose -f infra/compose.yaml)
"${COMPOSE[@]}" up -d bitcoind electrs rgb-proxy nostr-relay
for attempt in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password getblockchaininfo >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 60 ]]; then echo 'bitcoind did not become ready' >&2; exit 1; fi
  sleep 1
done
if [[ "${1:-}" != --legacy && "${1:-}" != --inspect ]]; then
  if ! docker image inspect "${PASSBOOK_RLN_IMAGE:-passbook-rln:d4762ac}" >/dev/null 2>&1; then
    bash infra/lightning.sh build
  fi
  bash infra/lightning.sh start
fi
