# repo-xray dataset changelog

## v2 (2026-11-25)

The five v1 cases unchanged apart from `"version": 2`, plus three new cases (eight in total, meeting the eight-per-mission target).

| Case       | Repository            | Language   | Size  | Expected facts |
| ---------- | --------------------- | ---------- | ----- | -------------- |
| anyhow     | dtolnay/anyhow        | Rust       | small | 6              |
| changesets | changesets/changesets | TypeScript | small | 5              |
| fastapi    | fastapi/fastapi       | Python     | large | 6              |

- `fastapi` uses `"size": "large"`; the `repo.size` enum is now `small | medium | large`. `REPO_XRAY_DATASET` points at `v2.jsonl`; `v1.jsonl` stays loadable and unchanged.
- Fact values use the exact names the deterministic analyser emits (`packages/runtime/src/missions/repo-xray/scan.ts`): `cargo test` (file rule on `#[test]` in test files), `Vitest` and `pytest` (dependency maps), `GitHub Actions` (`detectCi`). Manifest and entry-point values are repository paths as `analyseSnapshot` reports them; `fastapi/cli.py` comes from the `[project.scripts]` target `fastapi.cli:main`, `src/lib.rs` from the conventional Rust entry pattern.
- Verification, all on 2026-11-25 against the default branch, one request each, all HTTP 200:
  - anyhow: GitHub API repository and `/languages` (Rust only), recursive tree, raw `Cargo.toml`, `src/lib.rs`, `tests/test_context.rs` (`#[test]` present) and `.github/workflows/ci.yml` (`cargo test`).
  - changesets: GitHub API repository and `/languages` (TypeScript 917,345 bytes, JavaScript 3,878), recursive tree, raw root `package.json` (`vitest`, `@manypkg/cli` in devDependencies), `packages/cli/package.json` and `.github/workflows/ci.yml`.
  - fastapi: GitHub API repository (`size` 58,785 KB, which includes history), recursive tree (3,279 files; `.py` 4.1 MB against 24 KB of `.js` once Markdown and images are set aside, so no separate `/languages` call), raw `pyproject.toml`, `fastapi/cli.py` (`def main`) and `.github/workflows/test.yml`. Tarball size measured with one GET of `https://codeload.github.com/fastapi/fastapi/tar.gz/HEAD`, body discarded: 18,209,658 bytes (about 17.4 MiB, roughly 70 % of the 25 MiB cap). The tree is under the 6,000-file and 24 MiB kept-bytes snapshot limits.
- Excluded, and why:
  - changesets entry point: `packages/cli/bin.js` and `packages/cli/src/index.ts` are both derivable, but `entryPoints` is capped at 12 and earlier packages' `exports` (including `./package.json`) come first in path order, so the fact could fall off the list for reasons unrelated to quality.
  - changesets workspaces: declared in `pnpm-workspace.yaml`, which the manifest parser does not read; there is no workspace fact kind in any case.
  - `module` facts for all three: module ids depend on the depth heuristic in `moduleAssignment` and would be brittle.
  - anyhow runtime dependency: the crate has none; the dependency fact is the dev-dependency `thiserror`. Inline `#[cfg(test)]` modules under `src/` are not test files for the analyser, so `cargo test` relies on `tests/`.
- Candidates looked up but not used: honojs/hono, pallets/flask and psf/requests (API `size` only; not near the cap). No closer-to-cap repository was measured, to avoid repeated 20 MB downloads.
- Wired into `pnpm eval --mission repo` (adapter `src/missions/repo.ts`, judge `prompts/repo-judge.v1.md`). Not run live yet: these facts are checked against the source files, not against an analyser run.

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
