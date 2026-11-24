# Architecture

Delegate is a hand-written agent runtime on the Anthropic Messages API, wrapped in the controls an enterprise needs before it lets agents act: a policy engine on every tool call, a quarantined reader for untrusted content, an append-only event log, and durable jobs. This document describes the target architecture; `docs/PROGRESS.md` says what exists today.

## System overview

```mermaid
flowchart LR
  subgraph Clients
    UI[Web UI<br/>Next.js]
    CC[Claude Code / any MCP client]
    API[REST API + TS SDK]
    CLI[delegate CLI]
    TRG[Triggers<br/>cron · webhook · Slack]
  end

  subgraph Platform
    GW[Route handlers<br/>auth · RBAC · rate limits]
    MCP[MCP server]
    JOBS[Inngest durable jobs]
    RT[Runtime<br/>intake · planner · orchestrator · sub-agents · critic]
    POL[Policy engine]
    QR[Quarantined reader]
    TOOLS[Tools<br/>web_search · web_fetch · crawler · RAG · sandbox · MCP connectors]
  end

  subgraph Data
    PG[(Postgres + pgvector<br/>RLS)]
    EV[(run_events<br/>append-only)]
    AUD[(audit_log<br/>append-only)]
    RD[(Redis<br/>quotas)]
  end

  subgraph Models
    MP[ModelProvider<br/>Anthropic · Bedrock · Vertex]
  end

  UI & API & CLI --> GW
  CC --> MCP --> GW
  TRG --> GW
  GW --> JOBS --> RT
  RT --> POL --> TOOLS
  TOOLS --> QR --> RT
  RT --> MP
  RT --> EV
  POL --> AUD
  GW --> RD
  EV --> PG
  EV -. SSE replay-then-live .-> UI
```

## Runtime pipeline

```mermaid
flowchart TD
  G[Goal or mission input] --> I[Intake<br/>MissionSpec · zod]
  I --> P[Planner · strongest model<br/>typed step DAG]
  P --> A{Plan approval<br/>edit · approve}
  A -->|approved| O[Orchestrator<br/>concurrency limit · budgets]
  O --> S1[Researcher]
  O --> S2[Analyst]
  O --> S3[Builder]
  O --> S4[Engineer<br/>Agent SDK in sandbox]
  S1 & S2 & S3 & S4 --> R[Step results<br/>summary · findings · sources · confidence · artifacts]
  R -->|failure or new info| RP[Replan<br/>plan.revised + diff]
  RP --> O
  R --> C[Critic<br/>atomic claims · entailment · rubric]
  C -->|unsupported claims, max 2 loops| F[Fix step]
  F --> C
  C --> E[Editor / Deliver<br/>artifacts · summary · next actions]
```

**Contracts**

- `MissionSpec`: mission id, validated input, workspace, budget, policy set, requested deliverables.
- `PlanStep`: `{ id, role, objective, inputs: StepRef[], capabilities: Capability[], acceptance: string[], budgetShare }`. The planner emits it through structured outputs; the orchestrator refuses any step whose capabilities exceed what the mission allows.
- `StepResult`: `{ summary, findings[], sources[], confidence, artifacts[] }`. Sub-agent transcripts stay in the trace and never flow into another agent's context.
- Sub-agents run in isolated contexts. They share state only through step results and the run scratchpad.

**Model routing** (`packages/runtime/src/models.ts`)

| Role | Model | Why |
|---|---|---|
| Planner, synthesis, Editor | `claude-opus-5-5` | Plan quality and final writing dominate perceived quality |
| Researcher, Analyst, Builder, Critic scoring | `claude-sonnet-5-5` | Strong tool use at a fifth of Opus input cost |
| Quarantined reader, extraction, entailment, tool-output summaries | `claude-haiku-5-5` | High volume, narrow tasks |
| Engineer | Claude Agent SDK (model set per mission) | See ADR 0003 (M5) |

Every call goes through `ModelProvider`, so the same roles run on the Anthropic API, Bedrock or Vertex with the customer's own credentials.

**Context engineering**

- Cache breakpoints: (1) end of tool definitions + system prompt, (2) end of mission context, (3) last turn of the growing conversation. Volatile data (timestamps, ids) only after the last breakpoint.
- Tool outputs over a size threshold are summarised by the fast model before re-entering context; the raw output is stored as an artifact referenced from the trace.
- Each run has a scratchpad (`memories` rows scoped to the run) that agents write to with a tool instead of carrying notes in context.
- Each step has a token budget; the orchestrator stops a step that exceeds it and emits `usage.updated` + a budget event.

## Security model

```mermaid
flowchart LR
  U[Untrusted content<br/>web · uploads · connectors · tool output] --> F[Fetch hardening<br/>SSRF · size · time · robots]
  F --> Q[Quarantined reader<br/>fast model · no tools]
  Q -->|zod-validated extraction<br/>spans tagged untrusted| PA[Privileged agent<br/>has tools]
  PA -->|tool call| PE{Policy engine}
  PE -->|deny| AL[(audit_log)]
  PE -->|needs approval| AP[Approval queue] --> PE
  PE -->|allow| T[Tool execution<br/>capability-scoped]
  PE --> AL
  T --> U
```

The privileged agent never sees raw untrusted text, so instructions hidden in a page have nothing to talk to. Even if an extraction smuggles intent through, every tool call still has to pass the capability check and the policy engine, which are code, not prompts. Details and threat list: `docs/SECURITY.md`.

## Event stream

```mermaid
sequenceDiagram
  participant J as Inngest job
  participant R as Runtime
  participant E as run_events (Postgres)
  participant S as SSE route
  participant B as Browser

  J->>R: execute step (checkpointed)
  R->>E: append RunEvent (seq n)
  B->>S: GET /api/runs/:id/events?after=k
  S->>E: SELECT seq > k (replay)
  E-->>S: events k+1..n
  S-->>B: replay events
  S->>E: LISTEN run_events_:id (live)
  R->>E: append RunEvent (seq n+1)
  E-->>S: NOTIFY
  S-->>B: live event
  Note over B,S: on reconnect the browser sends Last-Event-ID = last seq
```

- `run_events` is append-only (no UPDATE/DELETE grants) with a per-run monotonically increasing `seq`. Every UI view, trace, metric, replay and fork is derived from it.
- Event types: `run.created, plan.proposed, plan.approved, plan.revised, step.started, agent.spawned, agent.message, tool.called, tool.result, policy.decided, artifact.created, artifact.updated, critic.flagged, approval.requested, approval.resolved, usage.updated, step.completed, run.completed, run.failed`.
- **Replay:** re-execute a run with `tool.result` events served from the log instead of the network, for deterministic debugging.
- **Fork from step N:** copy events up to step N's checkpoint into a new run, change prompt version, model or input, continue live, then diff output, cost and quality.

## Data model

```mermaid
erDiagram
  orgs ||--o{ workspaces : has
  orgs ||--o{ members : has
  workspaces ||--o{ runs : owns
  runs ||--o{ run_events : logs
  runs ||--o{ artifacts : produces
  runs ||--o{ approvals : requests
  workspaces ||--o{ policies : enforces
  workspaces ||--o{ audit_log : records
  workspaces ||--o{ memories : keeps
  workspaces ||--o{ documents : stores
  documents ||--o{ chunks : "split into (pgvector)"
```

Every tenant table carries `workspace_id`; row-level security restricts reads and writes to workspaces the current member belongs to (`app.current_member_id` set per transaction). `run_events` and `audit_log` are insert-only.

## Observability

Each model call, tool call and policy decision is an OpenTelemetry span following the GenAI semantic conventions (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus cache read/write tokens). Spans export over OTLP to Langfuse, Datadog or Honeycomb; the built-in waterfall reads the same data from `run_events`, so the product works without an external backend.
