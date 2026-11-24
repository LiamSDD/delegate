---
description: Prove the current change works before calling it done
---
Run, in order, and read every output:
1. `pnpm check` (typecheck, lint, test, build). Fix failures; do not skip tests.
2. If a mission or runtime path changed: run it end to end on a real target and record time, model mix and any fallback events.
3. If a screen changed: launch the app and use the `ux-critic` agent at 1440px and 390px, including loading, empty and error states.
4. If the runtime, prompts or policy changed: run `/eval` and `/redteam`.
Report exactly what ran and what it showed. Never write "should work".
