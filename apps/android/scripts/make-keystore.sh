#!/usr/bin/env bash
# Makes the LOCAL demo signing key for the sideloaded APK: apps/android/keystore/
# (gitignored). Not a store key; the APK is never published. Keeps an existing one.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p keystore
chmod 700 keystore
if [ -f keystore/passbook-demo.jks ] && [ -f keystore/keystore.properties ]; then
  echo "keystore/passbook-demo.jks exists; keeping it"
  exit 0
fi
pass=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
keytool -genkeypair -storetype PKCS12 -keystore keystore/passbook-demo.jks -alias passbook-demo \
  -keyalg RSA -keysize 3072 -validity 3650 -storepass "$pass" -keypass "$pass" \
  -dname "CN=Passbook demo build - sideload only - not for distribution" >/dev/null 2>&1 || { echo "keytool failed" >&2; exit 1; }
umask 077
cat > keystore/keystore.properties <<PROPS
storeFile=passbook-demo.jks
storePassword=$pass
keyAlias=passbook-demo
keyPassword=$pass
PROPS
chmod 600 keystore/passbook-demo.jks keystore/keystore.properties
echo "made keystore/passbook-demo.jks (local only; gitignored)"
