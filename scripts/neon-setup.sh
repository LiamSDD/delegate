#!/bin/sh
# Prompts for the Neon owner connection string (hidden), then runs
# packages/db/scripts/neon-setup.mjs. The value is never written to disk.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"

restore_echo() { stty echo 2>/dev/null || true; }
trap restore_echo EXIT INT TERM

printf 'Paste the Neon connection string (input is hidden), then press Enter: '
stty -echo 2>/dev/null || true
IFS= read -r owner_url
restore_echo
printf '\n'

if [ -z "$owner_url" ]; then
  echo "Nothing entered." >&2
  exit 1
fi

cd "$root/packages/db"
DATABASE_URL_UNPOOLED="$owner_url" node scripts/neon-setup.mjs
