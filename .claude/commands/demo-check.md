---
description: Pre-flight before recording or presenting a demo
---
Check, and report a pass/fail table:
1. `pnpm check` green on `main`; working tree clean.
2. `pnpm smoke`: every model in `config/models.json` answers a tool-calling probe; note any provider removed from a chain.
3. The deployed URL loads, `/api/health` is ok, guest quotas are reset.
4. Latest `/eval` and `/redteam` results are green and recent.
5. Walk `docs/DEMO_SCRIPT.md` for ${ARGUMENTS:-Demo A}: each screen exists and its states render.
