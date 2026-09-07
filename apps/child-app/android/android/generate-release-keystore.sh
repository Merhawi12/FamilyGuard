#!/usr/bin/env bash
#
# Generates the Parentix Child upload keystore and the matching keystore.properties.
#
# Run ONCE, on the machine that produces Play uploads:
#
#   apps/child-app/android/android/generate-release-keystore.sh
#
# ── The keystore is written outside the repository ───────────────────────────
#
# It lands in ~/.parentix-signing/Parentix-Child/, not next to this script.
# `keystore.properties` is git-ignored and so was the old in-tree keystore, but a
# gitignore entry is one edit away from not existing, and it does nothing about
# the other ways a working tree leaves a machine: a zip of the folder, a `git
# add -f`, a backup tool that does not read .gitignore, an editor syncing the
# workspace. Only the properties file — which is worthless without the key —
# lives in the project, and it points at the real key by absolute path.
#
# ── Losing this key ends the listing ─────────────────────────────────────────
#
# Google Play identifies an app by its signing certificate. Without this file you
# cannot ship another update to `ca.parentix.child` — the recovery is a support
# request to reset the upload key, and it only exists at all because Play App
# Signing holds the *app* signing key on Google's side. Back it up before you
# build anything: see README-SECURITY.txt in the backup package.
#
set -euo pipefail

SIGNING_DIR="${PARENTIX_SIGNING_DIR:-${HOME}/.parentix-signing/Parentix-Child}"
KEYSTORE_FILE="upload-key.jks"
ALIAS="parentix-child-upload"
PROPS_FILE="keystore.properties"

GRADLE_ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ -f "${SIGNING_DIR}/${KEYSTORE_FILE}" ]; then
  echo "ERROR: ${SIGNING_DIR}/${KEYSTORE_FILE} already exists. Refusing to overwrite it."
  echo "A second key is a second app on Play. Delete it deliberately if you really mean to."
  exit 1
fi

# JKS rather than PKCS12, deliberately. PKCS12 is the modern format and keytool
# will say so, but it stores one password for the whole file: pass it a distinct
# -keypass and it prints "Different store and key passwords not supported" and
# silently uses the store password for the key as well. Play accepts either
# format, and a genuinely separate key password is worth more here than the
# format warning costs.
STORE_TYPE="JKS"

echo "Two distinct passwords are needed: one opens the file, one unlocks the key."
echo "Generate them in a password manager and save them there BEFORE continuing."
read -r -s -p "Store password: " STORE_PW; echo
read -r -s -p "Key password:   " KEY_PW; echo

[ -n "$STORE_PW" ] && [ -n "$KEY_PW" ] || { echo "ERROR: both passwords are required."; exit 1; }

mkdir -p "$SIGNING_DIR"

# 10000 days ≈ 27 years. Play requires a certificate valid past 2033-10-22 and
# will reject a shorter one; RSA 4096 is above its 2048-bit floor.
keytool -genkeypair \
  -v \
  -keystore "${SIGNING_DIR}/${KEYSTORE_FILE}" \
  -storetype "$STORE_TYPE" \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -storepass "$STORE_PW" \
  -keypass "$KEY_PW" \
  -dname "CN=Parentix Child, OU=Mobile, O=Parentix, C=CA"

# Java reads .properties with backslash as an escape character, so a Windows path
# has to be written with forward slashes. Gradle's rootProject.file() passes an
# absolute path through unchanged.
# `pwd -W` is Git Bash's Windows-form path (C:/Users/...); plain `pwd` is right
# everywhere else. Braced so the fallback is a real alternative — `A || B && C`
# groups as `(A || B) && C`, which would print both forms on the machines where
# the first one works.
STORE_PATH="$(cd "$SIGNING_DIR" && { pwd -W 2>/dev/null || pwd; })/${KEYSTORE_FILE}"

umask 077
write_props() {
  cat > "$1" <<EOF
# Git-ignored. Read by app/build.gradle to sign release builds.
# The keystore itself is outside the repository; this file only points at it.
storeFile=${STORE_PATH}
storePassword=${STORE_PW}
keyAlias=${ALIAS}
keyPassword=${KEY_PW}
EOF
}

write_props "${GRADLE_ROOT}/${PROPS_FILE}"
# A second copy beside the keystore, so an offline backup of that one directory
# is enough to rebuild a build host. The properties file in the project is
# disposable; this one is not.
write_props "${SIGNING_DIR}/${PROPS_FILE}"

echo
echo "✅ Created ${SIGNING_DIR}/${KEYSTORE_FILE}"
echo "   and ${GRADLE_ROOT}/${PROPS_FILE} (git-ignored)."
echo
echo "   Record the certificate fingerprint — Play Console and the Google/Firebase"
echo "   consoles both ask for it:"
echo "     keytool -list -v -keystore \"${SIGNING_DIR}/${KEYSTORE_FILE}\" -alias ${ALIAS}"
echo
echo "   Back up ${SIGNING_DIR} now, then build a Play bundle with:"
echo "     npm run apk:child -- --bundle"
