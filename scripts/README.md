# scripts

Repository tooling that runs outside any package. Tested by `pnpm test:root`, linted by `pnpm lint:root`.

| Script | Purpose |
|---|---|
| `scan-secrets.mjs` | Secret scanner used by the pre-commit hook (`--staged`), for a full sweep (`--all`: tracked plus untracked files that are not ignored), or on explicit paths. |
| `format-staged.mjs` | Runs Prettier on staged files in the pre-commit hook. |
| `git-hooks.rc.sh` | Puts `node` and `pnpm` on `PATH` for git hooks. |
| `claude-hooks/` | Claude Code edit hooks. |

## Secret scanner

Rules: provider key prefixes (`sk-ant-`, `sk-`, Cerebras `csk-`, Groq `gsk_`, NVIDIA `nvapi-`), AWS access key ids, GitHub tokens, JWTs, private key blocks, credentials in URL userinfo (`postgres://user:pass@host`), and generic assignments where the name ends in `secret`, `token`, `password`, `apiKey` or `<something>_key` (snake, camel, kebab, JSON or YAML) and the value is a long, high-entropy literal. Values that are env var names (`"apiKeyEnv": "GROQ_API_KEY"`) or unquoted member access in code (`process.env.X`) are not literals and are ignored.

A file is a finding, not a skip, when it is a forbidden type (`.env`, `*.pem`, `id_rsa`, …) or a text file over 2 MiB. UTF-16 text (with or without a BOM) is decoded and scanned; other binary files are skipped.

For a verified false positive, add a pragma on the same line naming the rule shown in brackets in the report, for example `// secret-scan: allow url-credentials`. Several rules can be listed, separated by commas or spaces. A bare `secret-scan: allow` suppresses nothing.

## Git hooks and PATH

`simple-git-hooks` writes `.git/hooks/pre-commit` (secret scan, then Prettier) and `.git/hooks/pre-push` (`pnpm check`) when `pnpm install` runs. The hooks call `node` and `pnpm` from `PATH`, which git GUIs and non-login shells often do not have when Node lives in `~/.local/node/bin`.

Every generated hook sources `$SIMPLE_GIT_HOOKS_RC` first if it is set. Point it at `scripts/git-hooks.rc.sh` in your shell profile (and, for GUI clients on macOS, with `launchctl setenv`):

```sh
export SIMPLE_GIT_HOOKS_RC="$HOME/path/to/delegate/scripts/git-hooks.rc.sh"
```

The rc file keeps an existing `node` on `PATH`; otherwise it adds `$DELEGATE_NODE_BIN`, `$HOME/.local/node/bin` or `$HOME/.volta/bin`, whichever holds `node` first. If none does, the hook fails with a message instead of skipping the checks. Re-run `pnpm exec simple-git-hooks` after changing the hook commands in the root `package.json`.
