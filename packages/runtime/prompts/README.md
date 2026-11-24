# Prompts

Every prompt the runtime sends lives here as a versioned file. Prompts are code: they are reviewed, evaluated and referenced by version from eval results and from `run_events`, so a change in behaviour can always be traced to a change in a file.

## Naming

`<name>.v<N>.md`, for example `planner.v1.md`, `critic.v3.md`.

- `name` is lowercase kebab-case and matches the runtime component that uses it.
- `N` is a positive integer. A behaviour change (new instructions, new output fields, reordered rules) is a **new file** with `N + 1`; the old file stays until no eval baseline or replayable run references it, then its status becomes `retired`.
- Typos and formatting fixes that cannot change model behaviour may be edited in place. When in doubt, bump the version.

## Header

Each file starts with a front-matter block. `parsePromptFile` in `src/prompts.ts` validates it and a test checks every file in this folder, so a malformed header fails `pnpm test`.

```text
---
name: planner
version: 1
status: draft
intent: One sentence on what this prompt is for and what it must never do.
inputs: [mission_spec, allowed_capabilities, budget]
output: Plan
---
```

| Field | Meaning |
|---|---|
| `name` | Must equal the `<name>` part of the file name. |
| `version` | Must equal the `<N>` part of the file name. |
| `status` | `draft` (not used by any mission yet), `active` (used in product paths), `retired` (kept for replay and eval baselines only). |
| `intent` | Why the prompt exists, in one line. Reviewers judge changes against it. |
| `inputs` | Template variables the runtime fills, in `{{snake_case}}`. Nothing else is interpolated. |
| `output` | Name of the zod schema in the runtime that parses the model's answer (structured outputs where the provider supports them, one repair attempt otherwise). `text` for free-form prose. |

## Rules

- Security is enforced by the runtime, never by a prompt. A prompt may explain a constraint to the model, but the capability check, policy engine and quarantined reader are what enforce it.
- Untrusted content never appears in a privileged prompt. Only typed extractions from the quarantined reader, with spans tagged `untrusted`, are interpolated.
- Volatile values (timestamps, run ids) go after the last cache breakpoint, i.e. at the end of the user turn, so the system prompt stays cacheable.
- No model IDs in prompts. Prompts are written for roles (`planner`, `worker`, `fast`) and must work across the chain in `config/models.json`.
- Eval results record `name@version` for every prompt used in a trial (`packages/evals/src/types.ts`).
