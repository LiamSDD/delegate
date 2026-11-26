## Summary

<!-- What does this change and why? Link the issue it closes, e.g. "Closes #12". -->

## How it was verified

<!-- Commands you ran and what they showed. For runtime or prompt changes, the eval or red-team result. For UI changes, desktop and mobile screenshots including loading and error states. -->

## Checklist

- [ ] `pnpm check` passes (the pre-push hook runs it).
- [ ] Tests cover the change; security controls have a test, and a red-team case where it fits.
- [ ] TypeScript strict with no `any`; external and model output is parsed with zod.
- [ ] No new paid dependency, service or default; secrets only in env, and `.env.example` is updated if a variable was added.
- [ ] Unfinished work is behind a flag in `apps/web/src/flags.ts`.
- [ ] Docs, guides or an ADR are updated if behaviour or architecture changed.
- [ ] Commits follow Conventional Commits (`feat(runtime): ...`).
