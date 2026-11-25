# repo-xray dataset changelog

## v1 (2026-11-25)

Five well-known public repositories under the 25 MB archive cap, chosen for spread of language, layout and test framework. One `RepoXrayCaseSchema` case per line (`src/datasets/repo-xray.ts`).

| Case         | Repository           | Language   | Size   | Expected facts |
| ------------ | -------------------- | ---------- | ------ | -------------- |
| ky           | sindresorhus/ky      | TypeScript | small  | 5              |
| commander    | tj/commander.js      | JavaScript | small  | 5              |
| click        | pallets/click        | Python     | medium | 4              |
| itsdangerous | pallets/itsdangerous | Python     | small  | 4              |
| cobra        | spf13/cobra          | Go         | medium | 5              |

- Every expected fact was checked on 2026-11-25 against the file named in `sourceUrl` on the default branch (one raw read per file). Facts are deterministic and kind-typed (`language`, `test-framework`, `manifest`, `ci`, `entry-point`, `dependency`, `module`) so `factFound` in `src/graders/repo-xray.ts` checks them without a judge. Volatile facts (versions, star counts, file counts) are deliberately not expected.
- Deterministic graders (`gradeRepoXray`): hard checks `schema_valid` (deliverable and snapshot artifact parse, status `complete`), `citations_resolve` (every `path:line` range in the deliverable resolves to lines stored in the `repo-snapshot` artifact), `mermaid_nodes_real` (every diagram node is a module of the deliverable and a real path in the snapshot manifest, no dangling edges) and `improvements_valid` (5 to 8 improvements, each parses as `RepoImprovementSchema`, names a snapshot file unless it adds a test, ranks 1..n); soft check `expected_facts`.
- `gate` tag: ky, click.
- Not run live in this version: the runner (`pnpm eval --mission xray`) only drives Company X-ray today. Five cases is below the eight-per-mission target in `datasets/README.md`; v2 adds a Rust crate, a monorepo and a repository near the size cap.
