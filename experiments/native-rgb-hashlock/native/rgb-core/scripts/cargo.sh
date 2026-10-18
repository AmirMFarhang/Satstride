#!/usr/bin/env bash
# Run only this capability spike in its own constrained native builder.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
CACHE="$ROOT/data/native-build-cache"
mkdir -p "$CACHE/cargo" "$CACHE/target"
exec docker run --rm --name passbook-onchain-native-build \
  --network host --cpus 2 --memory 4g --memory-swap 6g \
  --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
  -e CARGO_BUILD_JOBS=2 -e CARGO_PROFILE_DEV_DEBUG=0 -e CARGO_INCREMENTAL=0 \
  -e PASSBOOK_G1_DATA_DIR="${PASSBOOK_G1_DATA_DIR:-}" \
  -v "$ROOT:/source" -v "$CACHE:/cache" \
  -w /source/native/rgb-core passbook-onchain-g1-rust:1.94 cargo "$@"
