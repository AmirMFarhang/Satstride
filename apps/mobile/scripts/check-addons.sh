#!/usr/bin/env bash
# Before Gradle: check every native addon the worklet bundle names (linked by the bundler into
# react-native-bare-kit's addons folder, see wdk.config.js) exists for arm64 and finds all its
# Bare/V8/libuv symbols in the Bare runtime react-native-bare-kit ships. An addon newer than the
# runtime then fails here, not as an ADDON_NOT_FOUND crash on the phone. (Found the hard way: with
# bare-kit 0.14.5, bare-type 1.4.0 needs js_get_object_type and bare-dns 2.3.0 bare_context_get;
# pinning older addons only moved the break to bare-assert, so the app uses bare-kit 0.16.0.)
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:=$HOME/Android/Sdk}"
nm=$(ls -d "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-nm | sort -V | tail -1)
kit=node_modules/react-native-bare-kit/android/libs/bare-kit/jni/arm64-v8a/libbare-kit.so
dir=node_modules/react-native-bare-kit/android/src/main/addons/arm64-v8a
exports=$(mktemp)
"$nm" -D --defined-only "$kit" | awk '{print $3}' | sort -u > "$exports"
bad=0; n=0
for so in $(grep -o 'linked:lib[^"\\]*\.so' .wdk-bundle/wdk-worklet.bundle.js | sed 's/linked://' | sort -u); do
  n=$((n + 1))
  if [ ! -f "$dir/$so" ]; then echo "missing addon: $so" >&2; bad=1; continue; fi
  miss=$("$nm" -D --undefined-only "$dir/$so" | awk '{print $2}' | grep -E '^(js_|bare_|uv_)' | sort -u | comm -23 - "$exports" | tr '\n' ' ' || true)
  if [ -n "$miss" ]; then echo "$so needs symbols the Bare runtime lacks: $miss" >&2; bad=1; fi
done
rm -f "$exports"
[ "$bad" = 0 ] || exit 1
echo "worklet addons ok: $n linked, all symbols resolve against $(node -p "'react-native-bare-kit ' + require('react-native-bare-kit/package.json').version")"
