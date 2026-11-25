# Try it in two minutes

You need a browser. There is no sign-up and no key to paste.

## 1. Open the live site

Go to https://delegate-beryl.vercel.app. Your first run creates an anonymous guest workspace for this browser, identified by a signed, HTTP-only session cookie that lasts 7 days. Runs you start are visible only to that session.

## 2. Give it one input

The box on the home page takes three kinds of input and shows which one it detected.

| You type | Detected as | Example |
|---|---|---|
| A company website | Company X-ray + AI Automation Audit | `stripe.com` |
| A GitHub repository | Repo X-ray | `github.com/sindresorhus/ky` |
| Anything else | Custom goal | `Map where our public docs contradict the pricing page` |

Under the box:

- For a company URL, choose **Automation Audit** (the default) or **X-ray**. An audit also takes an optional **Department**.
- For a goal, the **Autopilot** switch turns the run into a goal brief followed by up to three follow-up missions.
- **Auto-approve plans** skips the plan review in step 3. It is stored in a cookie, so it stays as you left it.

Press Enter. The app creates the run and opens its page.

Addresses with a custom port, a username or password, an IP address or a local hostname are rejected, and the box says why. Input is cut at 2,000 characters, and a goal at 900.

## 3. Review the plan

Unless auto-approve is on, the run stops at a card titled **Review the plan before any agent starts**. You can edit a step's objective, turn steps off, reorder them within their dependencies and rebalance the budget. Roles and capabilities are fixed by the planner and enforced by the runtime, so they cannot be edited.

Choose **Approve plan**, or **Reject** to stop the run. A plan nobody decides on within 10 minutes is rejected.

## 4. Watch it work

Each sub-agent gets its own lane: what it fetched, what the policy engine decided, which model answered. The bar at the top counts elapsed time, steps, tokens, cost and, once the critic has run, citation accuracy.

## 5. Read the result

The deliverable fills in on the right as the editor writes it. Each claim carries numbered citations. Select one to see the source and the exact quoted span that supports the claim. A section with too little evidence says so and does not guess.

When the run has finished, the top bar offers **Replay**, **Fork** and **Trace**. [Reading a run page](reading-a-run.md) explains each.

## What the public demo allows

| Limit | Value |
|---|---|
| Runs per guest | 5 per hour |
| Runs per network address | 20 per hour |
| Tokens per run | 400,000 |
| Spend per run | $0: the guest policy caps spend at zero |
| One server invocation | 300 seconds; a longer run is checkpointed and resumes from its last finished step when its page is next opened |
| Retention | Demo workspaces keep data for at most 7 days. See [privacy and retention](privacy-and-retention.md) |

The two run limits are counted in memory by each server instance, so they bound bursts and are not a global quota.

Missions have time targets in code: 90 seconds for a Company X-ray, 150 for an audit and 180 for Build it. They are targets, not guarantees. How long a run takes depends on which model in the chain answers.

## Next

- [Missions](missions.md): what each one takes, returns and refuses to do.
- [Connect Claude Code, Codex, Cursor or VS Code](connect-mcp-clients.md): start the same runs from your terminal.
- [Run locally](run-locally.md): the same app on your machine with one command.
