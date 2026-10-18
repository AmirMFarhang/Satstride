#!/usr/bin/env bash
# Makes the LOCAL demo signing key for the sideloaded wallet APK: apps/mobile/keystore/
# (gitignored). Not a store key; the APK is never published. Keeps an existing one.
# Separate from apps/android's key on purpose: the two apps install side by side.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p keystore
chmod 700 keystore
if [ -f keystore/passbook-wallet-demo.jks ] && [ -f keystore/keystore.properties ]; then
  echo "keystore/passbook-wallet-demo.jks exists; keeping it"
  exit 0
fi
pass=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
keytool -genkeypair -storetype PKCS12 -keystore keystore/passbook-wallet-demo.jks -alias passbook-wallet-demo \
  -keyalg RSA -keysize 3072 -validity 3650 -storepass "$pass" -keypass "$pass" \
  -dname "CN=Passbook Wallet demo build - sideload only - not for distribution" >/dev/null 2>&1 || { echo "keytool failed" >&2; exit 1; }
umask 077
cat > keystore/keystore.properties <<PROPS
storeFile=passbook-wallet-demo.jks
storePassword=$pass
keyAlias=passbook-wallet-demo
keyPassword=$pass
PROPS
chmod 600 keystore/passbook-wallet-demo.jks keystore/keystore.properties
echo "made keystore/passbook-wallet-demo.jks (local only; gitignored)"
