#!/bin/bash
set -euo pipefail

cd "${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../../.." && pwd)}"
version="$(sed -n 's/.*"node":[[:space:]]*">=\([0-9.]*\) <.*/\1/p' package.json)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
if [[ "$(node --version 2>/dev/null || true)" != "v$version" ]]; then
  temp="$(mktemp -d)"
  trap 'rm -rf "$temp"' EXIT
  case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) exit 1;; esac
  archive="node-v$version-darwin-$arch.tar.gz"
  url="https://nodejs.org/dist/v$version"
  curl --silent --show-error --fail --retry 3 "$url/$archive" -o "$temp/$archive"
  curl --silent --show-error --fail --retry 3 "$url/SHASUMS256.txt" -o "$temp/SHASUMS256.txt"
  (cd "$temp" && awk -v archive="$archive" '$2 == archive { print }' SHASUMS256.txt | shasum -a 256 -c -)
  tar -xzf "$temp/$archive" -C "$temp"
  export PATH="$temp/${archive%.tar.gz}/bin:$PATH"
fi
npm ci --no-audit --no-fund
npm run build:ios
