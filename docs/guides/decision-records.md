# Decision records

An architecture decision record, or ADR, captures one decision: the context that forced it, what was decided, and what it costs. Delegate has one for every architectural choice, and they are the best place to learn why the code is shaped the way it is.

Each record is a Markdown file in [`docs/adr`](../adr). When a decision changes, a later record amends or supersedes the earlier one and says so, or a dated amendment is added at the end of the original.

## All records

<!-- live:adr-index -->

## How to read one

- **Status and date** are at the top, with the records it builds on or amends.
- **Context** states the constraints. Three recur in almost every record: the default path must cost $0 and need no account, production is serverless with a 300-second limit per invocation, and the event log is the only source of truth.
- **Decision** is what the code does. It names files, limits and schemas, so it can be checked against the repository.
- **Consequences** lists what the decision costs and the known gaps. Records here state their weaknesses plainly, and the [security model](../SECURITY.md) tracks the risks that remain.

## Where to start

1. ADR 0001 explains why the agent loop is written by hand.
2. ADR 0002 explains the quarantined reader, the control everything else leans on.
3. ADR 0003 explains how the platform runs on free models.
4. ADR 0007 explains how a run survives a restart without a job service.

The [architecture overview](../ARCHITECTURE.md) shows how the pieces fit together.
