# Contributing to Delegate

Thanks for your interest. Bug reports, red-team cases that get through, eval findings and focused pull requests are all welcome.

## Set up

You need Node 26 or newer (`.nvmrc` says `26`) and pnpm 12.23 or newer. No accounts, keys or Docker are needed.

```bash
git clone https://github.com/LiamSDD/delegate && cd delegate
pnpm install      # also installs the git hooks
pnpm dev          # web app on http://localhost:3000 with an embedded database under .data/
```

With no provider keys every model role uses the keyless community endpoint, which is slow. `DELEGATE_FAKE_RUNNER=1 pnpm --filter @delegate/web dev` runs a scripted runner instead, so you can work on the run page without any model. Every optional variable is listed in [`.env.example`](.env.example) and explained in [Run locally](docs/guides/run-locally.md).

## Run the checks

There is no hosted CI. The gate runs on your machine, and the pre-push hook runs it for you.

```bash
pnpm check        # typecheck, lint, every test suite, eval smoke and build across the monorepo
pnpm redteam      # red-team suite; the attack success rate must stay at 0%
```

Scoped commands are faster while you work:

```bash
pnpm --filter @delegate/policy test
pnpm --filter @delegate/runtime test
pnpm --filter @delegate/web typecheck
pnpm --filter @delegate/web lint
pnpm format:check
```

`pnpm install` adds two hooks: a secret scan and formatter before each commit, and `pnpm check` before each push. Do not skip them. A push that fails the hook would fail review too.

## House rules

The working agreement is [`CLAUDE.md`](CLAUDE.md); the rules that matter most for contributors:

- TypeScript strict, no `any`, zod at every boundary. LLM output is untrusted input.
- Security lives in the runtime, never in prompts. A new control comes with a test, and usually a red-team case.
- The event log is the source of truth: no state that cannot be rebuilt from `run_events`.
- $0 by default: no dependency, service or default that costs money or needs an account.
- Honest numbers: never fake live output or hard-code model responses in product paths.
- Unfinished work goes behind a flag in `apps/web/src/flags.ts`, so `main` stays shippable.
- Architectural changes start with an ADR in [`docs/adr`](docs/adr) ([how](docs/guides/decision-records.md)).

## Propose a change

1. For anything beyond a small fix, open an issue first (bug report or feature request) so the approach is agreed before you write code. Questions and ideas go to [Discussions](https://github.com/LiamSDD/delegate/discussions).
2. Issues labelled [`good first issue`](https://github.com/LiamSDD/delegate/labels/good%20first%20issue) are small, scoped and have acceptance criteria.
3. Fork the repository, branch from `main` (for example `fix/web-trace-header`) and keep each pull request to one change.
4. Fill in the pull request template. Screens you changed need desktop and mobile screenshots, including loading and error states.
5. Pull requests are squash-merged once `pnpm check` passes and the review is done.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) with the package as the scope, small and focused, as in the history: `feat(runtime): ...`, `fix(web): ...`, `test(evals): ...`, `docs(adr): ...`, `refactor(policy): ...`. The subject says what changed in plain words; the body says why.

## Security and conduct

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
