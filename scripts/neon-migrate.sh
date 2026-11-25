#!/bin/sh
# Applies new migrations to the Neon database without touching the app login
# password or the Vercel variables. Prompts for the owner connection string.
set -eu

PATH="$HOME/.local/node/bin:$PATH"
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
DATABASE_URL_UNPOOLED="$owner_url" DELEGATE_MIGRATE_ONLY=1 DELEGATE_ENV_OUT=/dev/null node scripts/neon-setup.mjs
