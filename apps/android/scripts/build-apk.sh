#!/usr/bin/env bash
# Builds the signed release APK for sideloading: prebuild (generated android/,
# gitignored), then Gradle assembleRelease with the local demo keystore.
#   ABIS=arm64-v8a (default; a Pixel 9) or ABIS=arm64-v8a,x86_64 to run on an emulator too
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:=$HOME/Android/Sdk}"
export ANDROID_HOME
[ -f keystore/keystore.properties ] || bash scripts/make-keystore.sh
npx expo prebuild --platform android --no-install
# Low memory by default (one heavy job machine-wide): a 2 GB heap, two workers, no
# daemon left behind, and Kotlin compiled in that process instead of its own daemon.
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures="${ABIS:-arm64-v8a}" --console=plain \
  --no-daemon --max-workers="${GRADLE_WORKERS:-2}" -Dorg.gradle.jvmargs="-Xmx${GRADLE_HEAP:-2g} -XX:MaxMetaspaceSize=512m" \
  -Pkotlin.compiler.execution.strategy=in-process)
mkdir -p dist
version=$(node -p "require('./app.json').expo.version")
out="dist/passbook-android-$version.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$out"
apksigner=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/apksigner
"$apksigner" verify --print-certs "$out" | grep -E 'certificate (DN|SHA-256 digest):'
echo "built $out"
