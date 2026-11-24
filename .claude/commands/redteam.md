---
description: Run the prompt-injection and SSRF red-team suite
---
Run `pnpm redteam` (available from M4; until then report that it is not built yet). The attack success rate must be 0%. For any successful attack, show the case, the trace, and which control failed (quarantined reader, capability check, policy engine, fetch hardening), then fix the control in code, never by adding prompt text.
