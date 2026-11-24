#!/bin/sh
set -eu

name="${1:-}"
case "$name" in
  "" | *[!A-Z0-9_]*) echo "usage: sh scripts/set-env-key.sh NAME   (NAME in A-Z, 0-9, _)" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
file="$root/.env.local"

restore_echo() { stty echo 2>/dev/null || true; }
trap restore_echo EXIT INT TERM

printf 'Paste the value for %s (input is hidden), then press Enter: ' "$name"
stty -echo 2>/dev/null || true
IFS= read -r value
restore_echo
printf '\n'

if [ -z "$value" ]; then
  echo "Nothing entered; .env.local unchanged." >&2
  exit 1
fi

umask 077
touch "$file"
grep -v "^$name=" "$file" > "$file.tmp" || true
printf '%s=%s\n' "$name" "$value" >> "$file.tmp"
mv "$file.tmp" "$file"
chmod 600 "$file"
value=""

echo "Saved $name to .env.local (value not shown, file readable only by you)."
