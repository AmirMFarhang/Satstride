#!/usr/bin/env bash
# Optional real RLN stack. Always select your compose project explicitly.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PIN=d4762ac3d1b3ca83f2f7b4f894e8569109dc572a
IMAGE=passbook-rln:d4762ac
COMPOSE=(docker compose -f "$HERE/compose.yaml" -f "$HERE/compose.lightning.yaml")
case "${1:-}" in
  build)
    SRC=$(mktemp -d /tmp/passbook-rln-build-XXXXXX)
    git clone https://github.com/RGB-Tools/rgb-lightning-node.git "$SRC"
    git -C "$SRC" checkout "$PIN"
    git -C "$SRC" submodule update --init --depth 1
    # Cargo.lock pins rgb-lib and the RGB rust-lightning submodule pins LDK.
    sed -i 's/cargo build --release/cargo build --locked --release/' "$SRC/Dockerfile"
    docker build -t "$IMAGE" "$SRC"
    ;;
  start)
    : "${COMPOSE_PROJECT_NAME:?Set COMPOSE_PROJECT_NAME explicitly (for example passbook-lane-b)}"
    "${COMPOSE[@]}" up -d bitcoind electrs rgb-proxy passbook-rln-payer passbook-rln-payee
    ;;
  stop)
    : "${COMPOSE_PROJECT_NAME:?Set COMPOSE_PROJECT_NAME explicitly}"
    "${COMPOSE[@]}" stop passbook-rln-payer passbook-rln-payee
    ;;
  *) echo 'Usage: COMPOSE_PROJECT_NAME=<isolated project> infra/lightning.sh build|start|stop'; exit 1 ;;
esac
