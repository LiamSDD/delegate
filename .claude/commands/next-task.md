---
description: Pick up the next roadmap item and plan it
---
1. Read `CLAUDE.md`, the current milestone in `SPEC.md`, the last three entries of `docs/PROGRESS.md`, and `git log --oneline -20`.
2. Find the first unchecked item in the current milestone. If an earlier milestone's "Done when" is regressed, take that instead.
3. Write a short plan: files to touch, risks, how it will be verified (commands and the real target it runs on).
4. If the item changes architecture (new package, new data flow, new external dependency, security boundary), draft an ADR with `/adr` and stop for approval. Otherwise start building.
$ARGUMENTS
