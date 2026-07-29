#!/usr/bin/env bash
#
# Generates the Parentix upload/release keystore and a matching keystore.properties.
# Run ONCE, locally, on the machine that will produce Play uploads. The keystore and
# properties file are git-ignored — back them up somewhere safe (a password manager
# or secrets vault). If you lose this keystore you can no longer publish updates to
# the same app listing without Play App Signing key reset.
#
# Usage:  cd mobile/android && ./generate-release-keystore.sh
#
set -euo pipefail

KEYSTORE_FILE="parentix-release.keystore"
ALIAS="parentix"
PROPS_FILE="keystore.properties"

cd "$(dirname "$0")"

if [ -f "$KEYSTORE_FILE" ]; then
  echo "ERROR: $KEYSTORE_FILE already exists here. Refusing to overwrite it."
  echo "Delete/rename it deliberately if you really want a new key."
  exit 1
fi

echo "You'll be asked for a keystore password and a key password."
echo "Use strong, distinct values and store them in your password manager."
read -r -s -p "Store password: " STORE_PW; echo
read -r -s -p "Key password:   " KEY_PW; echo

keytool -genkeypair \
  -v \
  -keystore "$KEYSTORE_FILE" \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -storepass "$STORE_PW" \
  -keypass "$KEY_PW" \
  -dname "CN=Parentix, OU=Mobile, O=Parentix, L=, ST=, C=CA"

cat > "$PROPS_FILE" <<EOF
# Git-ignored. Consumed by app/build.gradle to sign release builds.
storeFile=$KEYSTORE_FILE
storePassword=$STORE_PW
keyAlias=$ALIAS
keyPassword=$KEY_PW
EOF

echo
echo "✅ Created $KEYSTORE_FILE and $PROPS_FILE (both git-ignored)."
echo "   Back them up now. Then build a signed bundle with:"
echo "     ./gradlew bundleRelease   # outputs app/build/outputs/bundle/release/app-release.aab"
