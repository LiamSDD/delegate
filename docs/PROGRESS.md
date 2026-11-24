# Progress log

Append one entry per completed task: date, shipped, next, known issues, metrics. Newest at the bottom.

## 2026-11-24 · Project memory

- **Shipped:** `SPEC.md` (spec + roadmap checkboxes), `CLAUDE.md`, `docs/ARCHITECTURE.md` (system, pipeline, security, event-stream and data-model diagrams), `docs/SECURITY.md` (threat model), ADR 0001 (hand-written runtime), ADR 0002 (quarantined reader), `docs/DEMO_SCRIPT.md`.
- **Versions checked:** Next.js 16.4.6, React 19.3.1, TypeScript 7.0.2, pnpm 12.23.0, Turborepo 2.11.13, Tailwind 4.3.5, Motion 14.14, Recharts 3.11, `@anthropic-ai/sdk` 1.13.0, `@anthropic-ai/claude-agent-sdk` 0.3.331, `@modelcontextprotocol/sdk` 1.32.2 (protocol 2025-11-25), Drizzle ORM 0.45.4 / kit 0.31.11, `@neondatabase/serverless` 1.2.1, Inngest 4.27.0, Upstash Redis 1.41.1 / Ratelimit 2.2.2, E2B 2.64.0, OpenTelemetry API 1.10.0 / SDK 0.301.2 / semconv 1.45.0, Vitest 5.1.1, Playwright 1.65.1, zod 4.6.7.
- **Next:** M0 plan review with the owner, then M0 implementation.
- **Known issues:** none yet; no code exists.
- **Stubs:** none.

## 2026-11-24 · Zero-cost operating constraint

- **Decided:** the owner spends $0 forever. ADR 0003 replaces Claude-only routing with role-based fallback chains across free open-weight providers; Claude becomes BYOK. Research is keyless.
- **Research sources (read 2026-11-24):** NVIDIA NIM catalog and Kimi K3 card (docs.api.nvidia.com), OpenRouter limits and privacy docs, Groq rate limits and data docs, Cerebras rate limits and models, Cloudflare Workers AI pricing, Z.ai pricing, Tavily/Jina/Brave search docs. Retired in 2026: GitHub Models (2026-07-30), Hugging Face free credits, Chutes free tier.
- **Unverified (check in M1 with real keys):** actual NVIDIA limits, Cerebras/Groq card requirements, Kimi tool calling on Cloudflare, Z.ai limits.
- **Next:** owner approval of the revised M0 plan.

## 2026-11-24 · Keyless default and no hosted CI

- **Decided:** no hosted CI (local `pnpm check` + pre-push hook, `pnpm gate` for evals/red-team). Default inference needs no keys: keyless hosted open models (Pollinations, LLM7) → in-browser WebLLM → local Ollama; free-tier keys and BYOK Claude are optional extras. ADR 0003 amended.
- **To verify in M1:** current Pollinations/LLM7 endpoints, limits, terms and tool calling; WebLLM model list with function calling.
