#!/bin/sh
set -eu
pid=$1
target=$2
next=$3
opener=$4
stage=${next%/*}
parent=${target%/*}
case "$stage" in "$parent"/.lingji-update-*) ;; *) exit 2;; esac
[ -d "$target" ] && [ -d "$next" ]
: > "$stage/helper-ready"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -lt 600 ] || exit 3
  sleep 0.2
done
previous="$stage/previous.app"
mv "$target" "$previous"
if ! mv "$next" "$target"; then mv "$previous" "$target"; exit 4; fi
if ! "$opener" "$target" --args --update-handoff "$stage"; then
  mv "$target" "$next"
  mv "$previous" "$target"
  "$opener" "$target" || true
  exit 5
fi
# The new client removes the backup only after its backend and UI report ready.
exit 0
