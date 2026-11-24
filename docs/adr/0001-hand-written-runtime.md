# ADR 0001: Hand-written agent runtime on the Messages API

- Status: Accepted
- Date: 2026-11-24

## Context

Delegate's value is the control around the agent: capability-scoped tools, a policy check before every call, a quarantined path for untrusted content, per-step budgets, an append-only event log that drives replay and fork, and prompt caching placed deliberately. Agent frameworks (LangGraph, CrewAI, the Claude Agent SDK, the SDK tool runner) hide the loop, which is exactly where these controls must sit. The project is also a portfolio piece: reviewers should be able to read the loop in one sitting.

## Decision

Write the agent loop by hand on the Anthropic TypeScript SDK (`client.messages.stream`), with:

- an explicit loop: send → stream → append the full assistant content → handle `stop_reason` (`tool_use`, `pause_turn`, `max_tokens`, `refusal`, `end_turn`) → policy-check and execute tool calls → append all `tool_result` blocks in one user message → repeat, bounded by iterations and budget;
- every model call, tool call and policy decision emitted as a typed `RunEvent` before and after it happens;
- tools registered with capabilities and zod schemas, executed only after the capability check and policy engine allow them;
- structured outputs (`output_config.format`) for planner, critic and extractions, because current Opus and Sonnet models reject forced `tool_choice`.

The Engineer sub-agent (code changes in a sandbox) is the single exception and uses the Claude Agent SDK; it gets its own ADR in M5.

## Consequences

- More code to own: streaming, retries, `pause_turn` resumption, error mapping and compaction are ours to write and test.
- Full control over cache breakpoints, budgets, event emission, replay and fork, which a framework would make awkward or impossible.
- The runtime has no framework lock-in, and `ModelProvider` keeps it portable across the Anthropic API, Bedrock and Vertex.
- Framework features we need later (compaction, threads) are adopted from the SDK directly, behind our interfaces.
