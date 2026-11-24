# ADR 0003: Zero-cost model routing across free open-weight providers

- Status: Accepted
- Date: 2026-11-24
- Supersedes: the Claude-only model routing in the original spec (Claude stays as an optional bring-your-own-key provider)

## Context

The owner runs Delegate for $0, indefinitely: no paid API, no card on file. Delegate still needs strong models with tool calling, streaming, structured output and long context. Free hosted inference for open-weight models exists, but each free tier is small, rate-limited, and changes often (GitHub Models, Hugging Face free credits and Chutes all disappeared during 2026). Research on 2026-11-24 (sources in `docs/PROGRESS.md`):

| Provider (OpenAI-compatible) | Strongest free models with tool calling | Free limits | Notes |
|---|---|---|---|
| NVIDIA API catalog (`integrate.api.nvidia.com/v1`) | `moonshotai/kimi-k3`, `deepseek-ai/deepseek-v4-pro`, `z-ai/glm-5.3`, `minimaxai/minimax-m2.7` | about 40 RPM per key (unofficial), long context | Trial terms: development and evaluation, not production |
| Groq (`api.groq.com/openai/v1`) | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` | 30 RPM, 1K RPD, 8K TPM, 200K TPD | Zero data retention can be enabled |
| Cerebras (`api.cerebras.ai/v1`) | `gpt-oss-120b`, `qwen-3.8-27b` | qwen: 300 RPM, 64k context on free tier | Very fast |
| OpenRouter (`openrouter.ai/api/v1`) | `nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-31b-it:free` | 20 RPM, 50 RPD | Per-provider data policies |
| Cloudflare Workers AI | `@cf/openai/gpt-oss-120b`, `@cf/zai-org/glm-4.7-flash` | 10,000 neurons/day | States no training on customer data |

## Decision

1. **One `ModelProvider` interface, two adapters:** an OpenAI-compatible adapter (covers every free provider above) and an Anthropic adapter (bring-your-own-key, used when a visitor or self-hoster supplies a Claude key). The runtime only sees normalised messages, tool calls, usage and stop reasons.
2. **Roles, not models.** The runtime asks for `planner`, `worker` or `fast`. `config/models.json` maps each role to an ordered fallback chain of `{provider, model}` entries, with each entry's context window, tool-call quirks and limits. Changing providers is a config change, not a code change.
3. **Router** in front of the providers: per-provider token buckets, `retry-after` handling, a context-window check before routing, health-based skipping after repeated failures, and a `model.fallback` event whenever it moves down a chain, so the UI and traces show which model actually served each call.
4. **Initial chains:**
   - `planner`: NVIDIA `kimi-k3` → NVIDIA `deepseek-v4-pro` → OpenRouter `nemotron-3-ultra:free` → Groq `gpt-oss-120b`
   - `worker`: Groq `gpt-oss-120b` → NVIDIA `glm-5.3` → Cerebras `gpt-oss-120b` → Cloudflare `gpt-oss-120b`
   - `fast`: Cerebras `qwen-3.8-27b` → Groq `qwen3.8-27b` → Cloudflare `glm-4.7-flash`
5. **Public demo vs owner runs.** NVIDIA's trial terms are for evaluation, so the public guest workspace uses the non-NVIDIA chains by default, with strict per-visitor quotas and a designed "free capacity used up" state. Owner-run evaluations and demo recordings may use NVIDIA. Visitors can bring their own Claude key to run live on Claude.
6. **Honesty in the UI.** Every run shows which provider and model served each step, and recorded runs are labelled "Replay" with the models used.
7. **A daily smoke test** calls each configured `{provider, model}` with a tiny tool-calling prompt and records pass/fail, so a disappearing free tier shows up before a demo does.

## Consequences

- $0 running cost; capacity is a few hundred agent runs a week across providers, enough for a portfolio demo and evals.
- Quality and latency vary by provider; evals record the serving model on every trial so comparisons stay valid, and the model × prompt Pareto chart compares free models directly.
- Provider-specific behaviour (Kimi expects reasoning content and tool calls echoed back, smaller free context windows, different caching) lives in adapter code with tests.
- Prompt caching is provider-dependent; the cache hit rate is reported where the provider exposes it and shown as "n/a" otherwise, never estimated.
- Claude-specific features (server-side web search, Claude Agent SDK) are not used on the default path. Web research uses keyless sources (ADR 0004, M1). The Engineer sub-agent (M5) will be redesigned on the hand-written runtime with a free sandbox option; a new ADR will record that.
- Data-use differs by provider; `docs/SECURITY.md` lists it, and the policy engine can block providers for workspaces that classify data as confidential.
