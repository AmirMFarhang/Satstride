#!/usr/bin/env bash
# Builds the signed release APK of the on-device wallet for sideloading: the worklet
# bundle, prebuild (generated android/, gitignored), then Gradle assembleRelease with
# the local demo keystore.
#   arm64-v8a only (a real phone such as the Pixel 9): the worklet bundle and the pinned rgb-lib
#   addon are arm64; scripts/fetch-native.sh refuses any other ABIS.
# Run through the shared memory slot documented in the live session claims.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:=$HOME/Android/Sdk}"
export ANDROID_HOME
[ -f keystore/keystore.properties ] || bash scripts/make-keystore.sh
bash scripts/fetch-native.sh
npx wdk-worklet-bundler generate
bash scripts/check-addons.sh
npx expo prebuild --platform android --no-install
# Low memory: a 2 GB heap, two workers, no daemon left
# behind, and Kotlin compiled in that process instead of its own daemon.
status=0
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures="${ABIS:-arm64-v8a}" --console=plain \
  --no-daemon --max-workers="${GRADLE_WORKERS:-2}" -Dorg.gradle.jvmargs="-Xmx${GRADLE_HEAP:-2g} -XX:MaxMetaspaceSize=512m" \
  -Pkotlin.compiler.execution.strategy=in-process) || status=$?
(cd android && ./gradlew --stop >/dev/null 2>&1) || true
[ "$status" = 0 ] || { echo "gradle failed ($status)" >&2; exit "$status"; }
mkdir -p dist
version=$(node -p "require('./app.json').expo.version")
out="dist/passbook-wallet-$version.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$out"
cp "$out" "dist/satstride-wallet-$version-arm64.apk"
apksigner=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/apksigner
"$apksigner" verify --print-certs "$out" | grep -E 'certificate (DN|SHA-256 digest):'
echo "built $out"
