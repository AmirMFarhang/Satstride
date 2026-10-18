#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
CACHE="$ROOT/data/assets-build-cache"
mkdir -p "$CACHE/cargo" "$CACHE/target"
exec docker run --rm --name passbook-onchain-assets-build \
  --network host --cpus 2 --memory 4g --memory-swap 6g \
  --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
  -e CARGO_BUILD_JOBS=2 -e CARGO_PROFILE_DEV_DEBUG=0 -e CARGO_INCREMENTAL=0 \
  -e PASSBOOK_ASSETS_DATA_DIR="${PASSBOOK_ASSETS_DATA_DIR:-}" \
  -e PASSBOOK_ASSETS_SOURCE_COMMIT="${PASSBOOK_ASSETS_SOURCE_COMMIT:-}" \
  -v "$ROOT:/source" -v "$CACHE:/cache" \
  -w /source/native/rgb-core/asset-spike "${PASSBOOK_ASSETS_BUILDER_IMAGE:-passbook-onchain-g1-rust:1.94}" cargo "$@"
