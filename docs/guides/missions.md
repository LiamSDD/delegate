# Missions

A mission is one folder in `packages/runtime/src/missions`: an input schema, a step library, the capabilities its steps may use and a deliverable schema. This page describes the seven that run today. Every number comes from a constant in the code at the path given, so it can be checked.

Two rules hold for all of them. Claims in a deliverable cite a fetched source, and a section the evidence cannot support says so. Nothing with a side effect happens without a human decision.

## Company X-ray

**Input.** A company website (`url`) and an optional `focus` of up to 500 characters.

**What it does.** It crawls the company's own site within robots.txt, looks the company up on Wikipedia, Wikidata and GitHub, reads the pages in quarantine, drafts the brief from the extracted facts only, follows up thin sections, and has the critic check each claim against its quotes.

**Deliverable.** A cited brief with eight sections: offering, customers, market, competitors, positioning, recent news, SWOT and tech-stack signals. A section without evidence is marked "Insufficient evidence" with a note. The brief reports its citation accuracy.

**Limits** (`company-xray/run.ts`). At most 60 pages crawled in 20 seconds, of which the quarantined reader reads 8. Gap filling makes at most three extra fetches. Deep research runs at most two rounds. The time target is 90 seconds.

## AI Automation Audit

**Input.** A company website, an optional `department` of up to 120 characters and an optional `focus`.

**What it does.** After the same research, one analyst per lens proposes workflows that agents could automate: Operations, Sales & Customer Success, Finance & Back-office, and Engineering & Product. An editor picks the most specific ones and ranks them. Code rejects generic ideas and requires each opportunity to cite evidence about this company.

**Deliverable.** 5 to 8 opportunities ranked by estimated euros per month, each with its evidence, a first step, an owner role and a success metric. The estimate is a formula, not a guess, and you can change its inputs on the run page:

```text
hours/month = frequency × minutes × people × adoption / 60
€/month     = hours × hourly cost
```

If fewer than five opportunities survive verification, the audit says how many it found and why. It does not pad the list.

**Limits** (`automation-audit/run.ts`). At most 60 pages crawled in 20 seconds, 12 read. ROI inputs are bounded: 1 to 400 times a month, 1 to 240 minutes per task, 1 to 50 people, adoption between 10% and 70%, and an hourly cost between €25 and €90. The time target is 150 seconds.

## Build it

The runtime calls this mission `build-agent`.

**Input.** A company website and a `goal` of up to 900 characters. On the run page you start it with the **Build it** button on an audit opportunity, which fills both in.

**What it does.** It crawls the site, chunks and indexes the pages, designs an assistant for the goal, writes an eval set from the crawled pages, asks the assistant every question and grades the answers, then reports what the site does not cover.

**Deliverable.** An assistant at `/agents/<id>` that answers only from the crawled pages, cites each claim and refuses when the site is silent. With it come the eval set and its pass rate, a gaps report and a one-line embed snippet.

**Limits** (`build-agent/crawler.ts`, `build-agent/run.ts`). At most 300 pages, 60 MB and 120 seconds of crawling, to depth 6, with a checkpoint every 60 pages so a run cut at the server's 300-second limit resumes without refetching. The eval set has up to 12 answerable questions and 3 that the site cannot answer. Retrieval is full-text search. Embeddings are added only when the server has an embedding provider configured. The time target is 180 seconds.

## Repo X-ray

**Input.** A public GitHub repository URL. A `/tree/<ref>` path or a separate `ref` selects a branch, tag or commit.

**What it does.** It downloads the repository once as an archive, analyses it in code (languages, manifests, entry points, an import graph, test files, risky patterns), reads the documentation in quarantine, and lets two models write prose from that evidence. Code text never reaches a model. Models cite numbered evidence items, and code maps them to `path:line` ranges.

**Deliverable.** An architecture summary with a module map, module responsibilities, an onboarding guide, dependency and security hotspots, test gaps, and 5 to 8 ranked improvements that are small enough to test. The critic verifies every citation against the stored snapshot.

**Limits** (`repo-xray/snapshot.ts`, `repo-xray/tarball.ts`, `repo-xray/run.ts`). The archive may be at most 25 MB compressed and 256 MB or 50,000 entries uncompressed. Files over 256 KB are skipped, and at most 6,000 files or 24 MB of text are kept. Reaching a cap produces a partial snapshot that says so. After 250 seconds the remaining model steps are skipped and the deliverable is published marked `partial`. The import graph covers JavaScript, TypeScript and Python.

## Ship-a-PR

**Input.** One improvement from a Repo X-ray, the repository URL and an optional ref. On the run page you start it with **Ship it** on an improvement.

**What it does.** It follows a fixed plan: prepare a sandbox, run the repository's own checks for a baseline, let the Engineer implement the change, run the checks again, then ask you. The Engineer can only read, search, write and run detected commands inside the repository copy, and the sandbox holds no secrets and no git credentials. In production the sandbox is a Vercel Sandbox microVM whose network is limited to package registries once dependencies are installed.

**Deliverable.** A pull request, or a patch with the before and after test reports. A pull request needs three things: a GitHub App installation that covers the repository, passing tests, and your approval of the exact diff. Everything else gets the patch. [Connect GitHub and Ship-a-PR](github-and-ship-a-pr.md) walks through it.

**Limits** (`ship-a-pr/run.ts`, `ship-a-pr/schema.ts`). The mission is off unless the deployment sets `DELEGATE_SHIP_A_PR=1`. The Engineer gets at most three rounds, each with up to 10 model turns and 30 tool calls, and 12 minutes in total. A diff may touch at most 50 files and 400 KB. An approval nobody answers within 10 minutes counts as a rejection.

## Custom goal

**Input.** A `goal` of 3 to 900 characters and an optional company `url`.

**What it does.** The planner composes a plan of 3 to 10 steps from the research, reading, synthesis and critic steps, in three phases: research, draft, verify. A company or domain named in the goal is resolved from the typed domain or from Wikidata. When the workspace has MCP connectors, the plan can include a step that uses them.

**Deliverable.** A cited goal brief: findings grouped by workstream, a ranked action plan and risks. Each action needs cited evidence, a concrete first step, a measurable success metric and an owner role. General background that is not about the target is cut to a short context note or dropped, and the brief reports how much was removed.

**Limits** (`custom-goal/run.ts`). At most 40 pages crawled in 15 seconds, 6 read. Deep research runs at most two rounds. The connector step makes at most six tool calls. There is a hard deadline of 230 seconds, after which the remaining steps are skipped and the brief is published marked `partial`.

## Autopilot

**Input.** A `goal` of 3 to 900 characters and an optional company `url`.

**What it does.** Autopilot is a coordinator. It calls no model and runs no tools. Its first child run is an ordinary custom goal that produces the brief. From the brief's first launchable action it picks a track: Company X-ray, then the audit, then Build it; or Repo X-ray, then Ship-a-PR. If no action can be launched and no company was resolved, it stops at the brief. Each hand-off parses the previous deliverable with its schema and builds the next input with the next mission's schema.

**Deliverable.** A mission graph of the child runs, each with its own page, plan, approvals and deliverable, and a report of what was done and what still needs a person.

**Limits** (`autopilot/schema.ts`, ADR 0016). At most 4 child runs, one level deep, within 45 minutes and 1.2 million tokens summed over the children. A failed child stops Autopilot. Every child counts against the guest run quota. Children keep their own approvals: a pull request still asks first. An Autopilot run cannot be forked. Fork the child you want to change.

## Shared behaviour

- **Budgets.** A guest run may use at most 400,000 tokens, and the guest policy caps spend at $0.
- **Durability.** A run that outlives one 300-second server invocation resumes from its event log. Steps that completed are restored from their checkpoints where the mission supports it. ADR 0007 lists which missions do.
- **Crawling.** At most 6 requests in flight per host and at least 100 ms between request starts, with robots.txt, `Crawl-delay` and `Retry-After` honoured. ADR 0012 has the full list of guards.
- **Models.** Missions ask for roles, never models. See [what Delegate is](what-is-delegate.md#models-and-cost).
