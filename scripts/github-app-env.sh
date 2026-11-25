#!/bin/sh
# Collects the GitHub App values after you create the App, generates the
# encryption key, and appends everything (plus DELEGATE_SHIP_A_PR=1) to
# .env.vercel.local so the whole block can be pasted into Vercel at once.
# Secrets are read with hidden input and never echoed.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/.env.vercel.local"

restore_echo() { stty echo 2>/dev/null || true; }
trap restore_echo EXIT INT TERM

ask() { printf '%s: ' "$1"; IFS= read -r value; printf '%s' "$value"; }
ask_hidden() {
  printf '%s (hidden): ' "$1" >&2
  stty -echo 2>/dev/null || true
  IFS= read -r value
  restore_echo
  printf '\n' >&2
  printf '%s' "$value"
}

app_id="$(ask 'App ID (the number on the App page)')"
case "$app_id" in "" | *[!0-9]*) echo "App ID must be a number." >&2; exit 1 ;; esac
slug="$(ask 'App slug (the last part of github.com/apps/<slug>)')"
client_id="$(ask 'Client ID (starts with Iv)')"
client_secret="$(ask_hidden 'Client secret')"

pem="$(ls -t "$HOME"/Downloads/*.private-key.pem 2>/dev/null | head -1 || true)"
if [ -z "$pem" ]; then
  pem="$(ask 'Path to the downloaded .pem private key')"
fi
if [ ! -f "$pem" ]; then
  echo "Private key file not found." >&2
  exit 1
fi
echo "Using private key: $pem"

key_line="$(awk 'NF {printf "%s\\n", $0}' "$pem")"
encryption_key="$(openssl rand -hex 32)"

umask 077
touch "$out"
for name in GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_CLIENT_ID GITHUB_APP_CLIENT_SECRET GITHUB_APP_PRIVATE_KEY DELEGATE_ENCRYPTION_KEY DELEGATE_SHIP_A_PR; do
  grep -v "^$name=" "$out" > "$out.tmp" || true
  mv "$out.tmp" "$out"
done
{
  printf 'GITHUB_APP_ID=%s\n' "$app_id"
  printf 'GITHUB_APP_SLUG=%s\n' "$slug"
  printf 'GITHUB_APP_CLIENT_ID=%s\n' "$client_id"
  printf 'GITHUB_APP_CLIENT_SECRET=%s\n' "$client_secret"
  printf 'GITHUB_APP_PRIVATE_KEY=%s\n' "$key_line"
  printf 'DELEGATE_ENCRYPTION_KEY=%s\n' "$encryption_key"
  printf 'DELEGATE_SHIP_A_PR=1\n'
} >> "$out"
chmod 600 "$out"
client_secret=""; key_line=""; encryption_key=""

echo "Saved to $out. Opening it: copy everything into Vercel's first Key box."
open -a TextEdit "$out" 2>/dev/null || true
