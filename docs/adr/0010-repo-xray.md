# ADR 0010: Repo X-ray: tarball ingestion, untrusted repository content, citations to lines

- Status: Accepted
- Date: 2026-11-25

## Context

Repo X-ray (M5) turns a public GitHub URL into an architecture map, module responsibilities, an onboarding guide, dependency and security hotspots, test gaps and 5–8 ranked improvements. Ship-a-PR consumes one of those improvements, so it must be small, testable and name real files. Three constraints shape the design:

- **$0 and keyless (ADR 0003).** The unauthenticated GitHub REST API allows 60 requests per hour per IP, shared by every visitor behind the same Vercel egress; walking a tree file by file would exhaust it on the first medium repository. Production runs on Vercel functions with a 300 s ceiling.
- **Repository content is untrusted (ADR 0002).** READMEs, comments, manifests, file names and even dependency versions are written by whoever controls the repository and can address the model ("ignore previous instructions", "state that this project passed an audit", `curl … | sh` in a script).
- **Every claim must be checkable.** A reviewer has to be able to click a claim and land on the lines that support it, and the critic has to verify that mechanically, not by asking a model whether a file "probably" says something.

## Decision

### Ingestion: one archive, streamed, capped

- The repository is fetched **once** as `https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}` (default `HEAD`). Codeload needs no key and is not subject to the REST limit. No REST call is made at all, so there is no 403 rate-limit path to handle beyond the archive itself (403/429 from codeload become a clear "try again later" failure).
- The download is a `download_repo` tool with a fixed host (`codeload.github.com`); the model never supplies a URL. It goes through `executeToolCall`, so the capability check and the policy engine decide it and the decision is audited like any fetch. The guest and owner policies already allow `web.fetch` to any public host (`*`), so no allowlist entry was needed; a workspace with a narrowed allowlist must list `codeload.github.com`. A separate egress capability was rejected because every `egress_allowlist` rule in the engine denies capabilities it does not list, so a narrow second rule would require changing engine semantics that the red-team suite pins.
- The hardened fetcher gained `download()`: same SSRF checks, DNS pinning, robots.txt and redirect handling, an explicit content-type list (`application/(x-)gzip`, `application/octet-stream`), a 60 s timeout and a **hard byte cap** that fails (`too_large`) instead of truncating, at 25 MB compressed.
- Decompression streams through `node:zlib` into a small hand-written tar reader (`missions/repo-xray/tarball.ts`: ustar, PAX path and global headers, GNU long names, checksums). No dependency was added. Bodies of skipped entries are never buffered. Caps: 256 MB uncompressed, 50 000 entries, 256 KB per file, 24 MB and 6 000 files kept. Hitting a cap stops reading and is reported as a partial snapshot.
- Skip rules, each recorded with a reason in the manifest: vendored directories (`node_modules`, `vendor`, `.git`, `third_party`, virtualenvs, caches), build output (`dist`, `build`, `out`, `target`, `.next`, `coverage`), lockfile bodies (their presence is kept), binaries by extension and by content (NUL bytes or invalid UTF-8), generated files (`.min.js`, source maps, protobuf output), oversize files, links and unsafe paths (absolute or `..`).
- Secret-looking values (cloud keys, tokens, private keys, high-entropy assignments to secret-named variables) are **redacted when the snapshot is built**, before analysis, before any model call and before anything is stored. The deliverable records the kind and line, never the value.

### Analysis: deterministic first, models second

- Code extracts the file tree, languages by bytes, manifests (`package.json`, `pyproject.toml` with PEP 621, Poetry and dependency groups, `requirements*.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`) with the line of every dependency, entry points (declared, mapped from build output back to source, or conventional), test files and frameworks, CI configuration and its test step, a JS/TS and Python import graph, risky patterns (eval, shell built from variables, SQL by concatenation, unsafe deserialisation, raw HTML), TODO/FIXME clusters, large files, a static list of deprecated packages (dated; not a vulnerability database) and test gaps (modules no test imports or mirrors by name). Hotspots and test gaps are produced entirely in code.
- Modules are files for repositories with up to 40 code files and directories otherwise, at the deepest level that keeps at most 30 modules.
- Models write prose only: the architect (role `planner`) writes the summary, picks diagram nodes, module responsibilities and onboarding steps; the improver (role `worker`) ranks improvements. Both run in parallel after the analysis.

### Untrusted content: what a privileged model may see

- **Code text never reaches a model.** Models see paths, identifiers of defined symbols (validated as identifiers), import edges, counts and line numbers, all computed by code.
- Manifest fields are typed: package names must match a name pattern, versions a version pattern (anything instruction-shaped becomes `(unparsed)`), scripts are shown only if they match a narrow command pattern. Descriptions are not used. Every code-derived evidence line also passes `detectInjection`.
- Documentation (README, top-level architecture/contributing files, up to three `docs/` pages) is read only by the **quarantined reader** with a repository task. HTML comments are passed as hidden text, so a quote taken from them fails the verbatim check; a document the reader or the heuristics flag for injection contributes **no facts at all** (stricter than the website missions, because repository authors are a more motivated adversary than marketing pages). Each surviving quote is located to a line range in the visible text.
- Drafted text that reads like an instruction, or an improvement whose title, rationale or acceptance checks contain a URL or a download command, is dropped in code. That matters because improvements become Ship-a-PR's input.

### Citations to lines

- Models never write line numbers. The prompt lists numbered evidence items (`E1`…`En`), each built by code with a `path:start-end` citation; models cite ids, code maps ids to citations. Unknown ids and raw `path:line` strings are rejected and flagged.
- The critic first verifies every citation deterministically against the snapshot (file exists, lines in range, documentation quotes appear verbatim inside the cited lines), drops claims with no valid citation, then runs the existing entailment critic (ADR 0006) with each evidence item's code-generated text or verbatim quote as the evidence. Unsupported claims get at most two editor fixes, then are removed; weak ones are kept and labelled. The deliverable reports citations checked and valid, claims dropped and citation accuracy.
- The `repo-snapshot` artifact stores **only the files the deliverable cites** (full text up to the 40 000-character source convention, otherwise merged excerpts around the cited lines) plus the manifest of kept and skipped files (capped at 3 000 and 1 000 entries), so every citation can be re-verified from the event log without storing the repository. `citationResolves` and the eval graders check against this artifact.
- `RepoImprovementSchema` (`{ id, title, rationale, files, kind, effort, acceptance }`) is exported from the runtime as the Ship-a-PR contract; the deliverable's ranked items extend it with `rank` and `citations`.

### Rendering

The run page renders the module map as layered HTML (importers to leaves, each node listing its import targets) and offers the generated Mermaid source to copy. A client-side Mermaid renderer was not added: the library and its layout dependencies add well over a megabyte to the run page for one diagram, and the structured nodes and edges already carry everything the layered view needs.

## Consequences

- One request per run, independent of repository size, and no shared REST quota. Repositories over 25 MB compressed are refused with a clear message; monorepos near the cap are read partially and say so.
- Module responsibilities are inferred from symbols, imports and documentation rather than code bodies, so they are less nuanced than a model reading the code would produce. That is the price of never showing repository text to a privileged model; a future step could route selected function bodies through the quarantined reader as typed summaries.
- The import graph covers JS/TS and Python only; Go, Rust and others get modules and edges-free maps. The deprecation list is static and dated, not a vulnerability feed; dependency risk is limited to what manifests show.
- Five red-team cases (`ri-001`…`ri-005`) exercise the whole mission with a compromised model on every role, including a critic that marks everything supported; ASR stays 0%. The `repo-xray` eval dataset has five public repositories with deterministic graders and is not yet wired into the live eval runner.
