#!/usr/bin/env bash
# Check market stack (docs/CHECK-MARKET.md). Its own Compose project and ports,
# so it never touches the demo chain:
#   bitcoind 18593, electrs 50161, rgb-proxy 3250, nostr 7927,
#   RGB Lightning (HODL build) borrower 3181, check node A 3182, check node B 3183
#
#   infra/check-market.sh build    build passbook-rln:hodl-61be1f7 (Rust, ~7 min, HEAVY)
#   infra/check-market.sh start    start the stack (mines 101 blocks on first start)
#   infra/check-market.sh stop     stop it, volumes kept (never down -v)
#   infra/check-market.sh env      print the environment the CLI and tests read
#
# The loan demo's --check-market path runs on this same stack (one chain for the
# loan and the check payment): start, eval the env, npm run seed, then
# npm run demo -- --check-market. Another session or a second chain picks its own
# project and ports: PASSBOOK_CHECK_PROJECT, PASSBOOK_CHECK_{BITCOIND,ELECTRS,PROXY,RELAY}_PORT
# and PASSBOOK_CHECK_RLN_{BORROWER,A,B}_PORT (defaults above).
#
# HODL invoices: the pinned RGB Lightning Node d4762ac has no payment_hash on
# /lninvoice and no claim route. UTEXO-Protocol/rgb-lightning-node commit
# 61be1f7 ("add support for HODL invoices", on RGB-Tools 244f44c) adds
# payment_hash to /lninvoice plus /claimhodlinvoice and /cancelhodlinvoice.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export COMPOSE_PROJECT_NAME=${PASSBOOK_CHECK_PROJECT:-passbook-checks}
export PASSBOOK_BITCOIND_PORT=${PASSBOOK_CHECK_BITCOIND_PORT:-18593} PASSBOOK_ELECTRS_PORT=${PASSBOOK_CHECK_ELECTRS_PORT:-50161} PASSBOOK_PROXY_PORT=${PASSBOOK_CHECK_PROXY_PORT:-3250} PASSBOOK_RELAY_PORT=${PASSBOOK_CHECK_RELAY_PORT:-7927}
export PASSBOOK_CHECK_RLN_BORROWER_PORT=${PASSBOOK_CHECK_RLN_BORROWER_PORT:-3181} PASSBOOK_CHECK_RLN_A_PORT=${PASSBOOK_CHECK_RLN_A_PORT:-3182} PASSBOOK_CHECK_RLN_B_PORT=${PASSBOOK_CHECK_RLN_B_PORT:-3183}
HODL_REPO=https://github.com/UTEXO-Protocol/rgb-lightning-node.git
HODL_PIN=61be1f762efe494725148d69479e8002e8d0f698
IMAGE=passbook-rln:hodl-61be1f7
COMPOSE=(docker compose -f "$HERE/compose.yaml" -f "$HERE/compose.checks.yaml")
RPC=("${COMPOSE[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcuser=user -rpcpassword=password)
case "${1:-}" in
  build)
    SRC=$(mktemp -d /tmp/passbook-rln-hodl-XXXXXX)
    git clone "$HODL_REPO" "$SRC"
    git -C "$SRC" checkout "$HODL_PIN"
    git -C "$SRC" submodule update --init --depth 1
    sed -i 's/cargo build --release/cargo build --locked --release -j 4/' "$SRC/Dockerfile"
    docker build -t "$IMAGE" "$SRC"
    ;;
  start)
    "${COMPOSE[@]}" up -d bitcoind electrs rgb-proxy nostr-relay check-rln-borrower check-rln-a check-rln-b
    for _ in $(seq 1 60); do "${RPC[@]}" getblockchaininfo >/dev/null 2>&1 && break; sleep 1; done
    "${RPC[@]}" createwallet miner >/dev/null 2>&1 || "${RPC[@]}" loadwallet miner >/dev/null 2>&1 || true
    if [ "$("${RPC[@]}" getblockcount)" -lt 101 ]; then "${RPC[@]}" generatetoaddress 101 "$("${RPC[@]}" -rpcwallet=miner getnewaddress)" >/dev/null; fi
    echo "check market stack up (project $COMPOSE_PROJECT_NAME)"
    ;;
  stop)
    "${COMPOSE[@]}" stop
    ;;
  env)
    # Linux: the proxy's bridge address is reachable from the host WDK wallets and from the RGB Lightning containers,
    # so both sides of an on-chain RGB transfer use the same consignment endpoint (docs/ATOMIC.md).
    proxy_ip=$(docker inspect "$COMPOSE_PROJECT_NAME-rgb-proxy-1" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || true)
    cat <<ENV
export COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
export BITCOIND_URL=http://127.0.0.1:$PASSBOOK_BITCOIND_PORT BITCOIND_USER=user BITCOIND_PASSWORD=password
export PASSBOOK_BITCOIND_PORT=$PASSBOOK_BITCOIND_PORT PASSBOOK_ELECTRS_PORT=$PASSBOOK_ELECTRS_PORT PASSBOOK_PROXY_PORT=$PASSBOOK_PROXY_PORT PASSBOOK_RELAY_PORT=$PASSBOOK_RELAY_PORT
export PASSBOOK_RELAYS=ws://127.0.0.1:$PASSBOOK_RELAY_PORT
export PASSBOOK_CHECK_LN_BORROWER=http://127.0.0.1:$PASSBOOK_CHECK_RLN_BORROWER_PORT PASSBOOK_CHECK_LN_A=http://127.0.0.1:$PASSBOOK_CHECK_RLN_A_PORT PASSBOOK_CHECK_LN_B=http://127.0.0.1:$PASSBOOK_CHECK_RLN_B_PORT
export PASSBOOK_CHECK_PROXY=rpc://${proxy_ip:-rgb-proxy}:3000/json-rpc RGB_TRANSPORT_URL=rpc://${proxy_ip:-127.0.0.1}:3000/json-rpc
ENV
    ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
