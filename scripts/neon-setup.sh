#!/bin/sh
# Prompts for the Neon owner connection string (hidden), sets up the database,
# and writes the Vercel environment variables to .env.vercel.local (private,
# gitignored). The owner connection string is never written to disk.
set -eu

PATH="$HOME/.local/node/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/.env.vercel.local"

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

umask 077
cd "$root/packages/db"
DATABASE_URL_UNPOOLED="$owner_url" DELEGATE_ENV_OUT="$out" node scripts/neon-setup.mjs
owner_url=""

if grep -q '^NVIDIA_API_KEY=' "$root/.env.local" 2>/dev/null; then
  grep '^NVIDIA_API_KEY=' "$root/.env.local" >> "$out"
else
  echo "NVIDIA_API_KEY was not found in .env.local; add it in Vercel by hand." >&2
fi
chmod 600 "$out"

echo "Saved the three Vercel variables to $out (only you can read it)."
open -e "$out" 2>/dev/null || true
