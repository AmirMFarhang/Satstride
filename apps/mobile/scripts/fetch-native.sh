#!/usr/bin/env bash
# Fetches the one native RGB binary the phone needs: @utexo/rgb-lib-bare's Bare addon for
# android-arm64, from UTEXO-Protocol/rgb-lib-bare's GitHub release, checked against a pinned
# sha256 (GitHub's published digest for that asset). The package's own postinstall would
# download every platform's static libraries and addons (~1.5 GB); .npmrc turns it off.
# arm64-v8a only: the worklet bundle targets android-arm64 (wdk.config.js) and only that
# addon's sha256 is pinned, so an x86_64 (emulator) build is refused rather than half-made.
set -euo pipefail
[ "${ABIS:-arm64-v8a}" = "arm64-v8a" ] || { echo "ABIS=${ABIS}: this build is arm64-v8a only (a real phone); x86_64 emulators are not supported" >&2; exit 1; }
cd "$(dirname "$0")/.."
PKG=node_modules/@utexo/rgb-lib-bare
want=$(node -p "require('./package.json').dependencies['@utexo/rgb-lib-bare']")
have=$(node -p "require('./$PKG/package.json').version")
[ "$want" = "$have" ] || { echo "rgb-lib-bare $have installed, package.json pins $want: update this script" >&2; exit 1; }
# rgb-lib-bare 0.3.0-beta.18 ships the addons of release v0.3.0-beta.17 (its download-libs.sh)
RELEASE=v0.3.0-beta.17
declare -A SHA=(
  [android-arm64]=4f0b7e016c0cca144976bee51a2d4094d7dde305593fce16f0f319d191e316e8
)
hosts=(android-arm64)
for host in "${hosts[@]}"; do
  out="$PKG/prebuilds/$host/utexo__rgb-lib-bare.bare"
  sum="${SHA[$host]}"
  [ -n "$sum" ] || { echo "no pinned sha256 for $host" >&2; exit 1; }
  if [ -f "$out" ] && echo "$sum  $out" | sha256sum -c --quiet 2>/dev/null; then echo "$host addon present"; continue; fi
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/addon.bare" "https://github.com/UTEXO-Protocol/rgb-lib-bare/releases/download/$RELEASE/utexo__rgb-lib-bare-$host.bare"
  echo "$sum  $tmp/addon.bare" | sha256sum -c --quiet || { echo "sha256 mismatch for $host" >&2; rm -rf "$tmp"; exit 1; }
  mkdir -p "$(dirname "$out")"
  mv "$tmp/addon.bare" "$out"
  rm -rf "$tmp"
  echo "$host addon fetched ($(du -h "$out" | cut -f1)), sha256 ok"
done
