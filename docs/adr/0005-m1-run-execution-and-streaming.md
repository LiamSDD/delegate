# ADR 0005: Run execution, event storage and streaming before durable jobs

- Status: Accepted
- Date: 2026-11-24

## Context

M1 needs real runs that stream to the browser and survive a page reload. Durable execution with Inngest is scheduled for M3. The project runs at $0 on Vercel Hobby and Neon's free tier, and must also run locally with no accounts and no Docker.

## Decision

1. **Execution (M1–M2):** `POST /api/runs` validates the input, creates the run and its `run.created` event, returns the run id immediately, and continues the run in the same server process with Next.js `after()`. A run is bounded by its budget and the function's maximum duration. M3 replaces this with Inngest steps without changing the event contract.
2. **Storage:** every event is written with `appendRunEvent` before it is published; the database is the only source of truth. Locally the app uses an embedded PGlite database persisted under `.data/` with the real migrations applied at start-up, so `pnpm dev` works with no accounts. Deployed, it uses Neon through the non-owner app login role.
3. **Streaming:** `GET /api/runs/:id/events` is a Server-Sent Events route that replays events after `Last-Event-ID` (or `?after=`), then polls for new events every 250 ms until the run is terminal or the client disconnects. Polling, not LISTEN/NOTIFY, because serverless functions cannot hold a database listener open and polling costs nothing at demo scale.
4. **Guest workspaces:** first visit creates an anonymous guest user and a demo workspace (7-day retention), identified by a signed, HTTP-only cookie (`DELEGATE_SESSION_SECRET`). The guest policy (`packages/policy` defaults) applies.
5. **Browser state** is a client-side `foldRun` over the streamed events, so a reload rebuilds exactly the same view.

## Consequences

- A process crash mid-run leaves a run in a non-terminal state; M1 marks such runs `failed` on next read after a timeout. True resume comes with M3.
- Polling adds up to 250 ms latency per event; acceptable against the 2-second time-to-first-event target.
- PGlite locally and Neon in production run the same migrations; differences (real concurrency, roles created outside migrations) are covered in `packages/db/README.md`.
