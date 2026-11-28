# How I built Delegate with Claude Code

Delegate is an agent platform that turns a goal or a company URL into finished, cited work. It is live at https://trydelegate.app, it runs on free open-weight models at $0 per run, and the code is open at https://github.com/LiamSDD/delegate.

This is how it was built: one engineer directing coding agents inside a harness, with the guardrails doing most of the work.

## The constraint that shaped everything

I set three rules before writing any code:

1. **$0 to run, no sign-up.** No paid model, no paid infrastructure. It runs on NVIDIA-hosted open-weight models with a keyless fallback, on Vercel Hobby and Neon free tier.
2. **Security lives in code, not prompts.** A prompt saying "don't do X" is not a control. Capabilities, approvals and the quarantine are code paths with tests.
3. **Honest numbers.** Every metric on the site comes from code in the repo, with confidence intervals where the sample is small.

## How the work was organised

The repo has a `CLAUDE.md` working agreement, a `SPEC.md` roadmap split into milestones, and an ADR for every architectural decision (20 so far). Each milestone followed the same loop:

1. **Plan.** I wrote the milestone plan and the acceptance condition ("done when attack success rate is 0% and a fork starts in under 10 s").
2. **Fan out.** Independent features went to parallel coding agents, each in its own git worktree, with a written brief: files to read, constraints, what done looks like, what not to touch.
3. **Merge in order.** Branches merged one at a time; each agent merged `main` into its own branch and resolved conflicts with its own context.
4. **Independent review.** Separate reviewer agents (security and correctness) read the whole milestone diff without seeing the implementers' reasoning.
5. **Fix with tests.** Every finding got a failing test first. Several also became red-team cases.
6. **Measure live.** Deploy, run the eval suite against real sites on the real models, and fix what the numbers show.

The local gate (`pnpm check`: typecheck, lint, 2,700 tests, build, eval smoke, red-team) replaces CI. Nothing is pushed unless it passes.

## What the reviews and evals caught

The point of the harness is that problems are found by the process, not by luck. Some real examples:

- **A pull request could contain different code from the diff a human approved.** A background process left running in the sandbox could edit a file during the approval window. Fix: the PR is built from the approved bytes, with a SHA-256 per file, and the sandbox is stopped before approval.
- **Read-only org members could link an all-repos GitHub installation.** Fix: push permission is checked for the specific repository at ship time.
- **Quotes could match mid-word.** "safe for fragile glassware" passed against "unsafe…". Found by writing the red-team suite. Fix: word-boundary alignment, with special handling for scripts without spaces (Japanese, Chinese, Thai) after a reviewer showed the first fix broke them.
- **Pages over 2 MB failed a whole Company X-ray.** Found by the first live eval (Atlassian and Zed). Fix: keep the capped prefix. Both went from failing to scoring 1.00.
- **Migrations that passed locally failed on Neon**, because the production owner is not a superuser. Two real permission bugs, invisible in tests that ran as superuser.

## Architecture in five decisions

1. **Hand-written agent loop** (about 170 lines) instead of a framework, so capability checks, budgets and approvals sit at fixed, tested points.
2. **Quarantined reader.** Untrusted pages are read by a tool-less model that returns only typed facts with verbatim quotes; code verifies the quotes.
3. **The event log is the source of truth.** UI, trace, replay, fork and crash recovery are all folds over an append-only log.
4. **Tenant isolation in Postgres**, with FORCE row-level security and an app role that cannot bypass it.
5. **Evals and red-team as gates**, with confidence intervals, and prompt changes promoted only when they beat the baseline.

## Results

- The red-team suite runs in the local gate before every push; the committed run has 0% attack success.
- Company X-ray live eval: 81% pass (95% CI 57–93%, n=16), median 62 s, $0.
- Fork from any step: first new event in 0.2 s on the live site.
- Crawl engine: 150 pages in 15.5 s (was over 150 s), never more than 6 concurrent requests per host.

## What I would tell another engineer

Coding agents make writing code cheap. They do not make judgement cheap. The leverage comes from three things: written constraints the agents must follow, independent reviewers that do not share the implementer's assumptions, and measurements against the real world. Most of my time went into briefs, reviews and evals, not into typing code.

## Not done yet

No real users yet, eval samples are still small, and the Ship-a-PR flow has not opened a live pull request on a public repository. Those are next.
