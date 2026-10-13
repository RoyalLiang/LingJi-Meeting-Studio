#!/usr/bin/env bash
set -euo pipefail
[[ "${CI:-}" == true && "${RUNNER_OS:-}" == macOS ]] || { printf '%s\n' 'Certificate import is restricted to the macOS CI runner' >&2; exit 1; }
: "${APPLE_CERTIFICATE:?Apple Developer ID certificate is required}"
: "${APPLE_CERTIFICATE_PASSWORD:?Certificate password is required}"
: "${RUNNER_TEMP:?Runner temporary directory is required}"
keychain_password="$(openssl rand -base64 32)"
printf '::add-mask::%s\n' "$keychain_password"
certificate_path="$RUNNER_TEMP/lingji-release.p12"
keychain_path="$RUNNER_TEMP/lingji-release.keychain-db"
trap 'rm -f "$certificate_path"' EXIT
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$certificate_path"
chmod 600 "$certificate_path"
security create-keychain -p "$keychain_password" "$keychain_path"
security default-keychain -s "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -t 3600 -u "$keychain_path"
security import "$certificate_path" -k "$keychain_path" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path"
