# Privacy and retention

This page says what Delegate stores, what it redacts, who can read it and when it is deleted. It describes the code in this repository. The operator of a deployment is responsible for the parts that are deployment steps, and those are called out.

## Who you are to the system

There are no accounts. The first time you start a run, the server creates an anonymous guest user and a demo workspace, and gives your browser a session cookie.

| Stored in your browser | Purpose | Lifetime |
|---|---|---|
| `delegate_session` cookie | Identifies your guest workspace. Signed with the server's secret, HTTP-only, `SameSite=Lax`, and `Secure` in production. | 7 days |
| `delegate_auto_approve` cookie | Remembers the "Auto-approve plans" switch on the home page. | 180 days |
| A nonce cookie while you connect GitHub | Binds GitHub's response to your session. | 10 minutes |
| `delegate-theme` in local storage | Light or dark theme. | Until you clear it |

No email address or name is asked for. When the session cookie expires, that browser can no longer reach the workspace, and there is no recovery, because there is no account to recover.

The pages load no third-party scripts, fonts or trackers. The Content-Security-Policy header restricts scripts, connections, images and fonts to the site's own origin, so the browser would refuse them.

## What a run stores

A run is its event log. For each run the database holds:

- the input you submitted;
- the plan and its revisions, and who approved them;
- each tool call with a summary of its arguments and result;
- each policy decision and approval;
- artifacts: snapshots of the public pages that were cited, and the deliverable;
- token counts and which models served the run.

A workspace can also hold the assistants built by Build it, with the pages crawled for them, plus API token hashes, connector settings and GitHub installation links.

## Who can read it

Tenant isolation is enforced by Postgres, not only by application code.

- Every tenant table has row-level security forced on. A row is visible only to members of its workspace.
- The app connects as a role that owns nothing and cannot bypass row-level security. It refuses to start with a login that can.
- `run_events` and `audit_log` are append-only: the app's role has no `UPDATE` or `DELETE` on them.

Runs in a guest workspace are visible to the browser holding that session cookie, and to API tokens that guest created.

## What is redacted

Before an event reaches the log or the server's logs, the run emitter replaces emails, phone numbers, card numbers that pass an issuer and Luhn check, and IBANs that pass the mod-97 check with `[redacted:<kind>]`. It rewrites:

- the summary and error of every tool result;
- the reason of every policy decision;
- the message of a failed run.

The event then records how many values were replaced. The original value is not stored or logged.

Some content is deliberately left as written:

- **Source snapshots and the deliverable.** The critic and the evals check that each quote appears verbatim in its source. Redacting one side would make true quotes fail. This content comes from public pages and is scoped to your workspace.
- **Text sent to a model.** The quarantined reader needs the page as written.

So a deliverable can contain personal data that a company published about itself. Connector output is different, because it is not public: its stored copy is redacted before it is written.

## Where prompts go

Model calls leave the server for a hosted provider. `config/models.json` lists the providers, and each entry records the provider's terms and the highest data classification it may receive. The guest policy allows only providers whose terms cover the public demo, and it forbids sending confidential or restricted data to any tool.

On the public demo, what is sent to a model is content fetched from public sources plus the goal or URL you typed. If you add connectors, the facts extracted from their output are sent too. Do not put secrets in a goal.

## Secrets

- Provider keys live in environment variables. They are never sent to a model and never logged.
- An API token is shown once. The database stores its SHA-256 hash and a 12-character prefix.
- A connector secret is encrypted with AES-256-GCM before it is stored, and is never returned to the browser.
- Connect GitHub uses your GitHub user token only during the callback request and does not store it. The installation token for a pull request is minted for one run and one repository and is never stored or logged.

## Retention

Demo workspaces keep data for at most 7 days. The database enforces the limit with a constraint: a demo workspace cannot have a longer retention period.

Deletion is done by the database function `purge_expired_demo_runs()`:

1. It collects demo runs older than the workspace's retention period, and every fork of them, since a fork cannot be replayed without its parent's events.
2. It deletes the matching demo audit rows.
3. It deletes the runs. Their events, artifacts, approvals and memories go with them.

Only the database owner and logins with the `delegate_maintenance` role may call it. The append-only tables accept a delete only from inside that function, so nothing else can remove history, not even the owner in a normal session.

**Scheduling the purge is a deployment step.** Nothing in this repository calls the function on a timer. A deployment needs a scheduler with a maintenance login to run it. Until it runs, expired rows stay in the database, although a session whose cookie has expired can no longer reach them.

Two more limits to know:

- There is no path yet to delete a whole workspace on request. Demo workspaces shed their data through the purge.
- Audit rows in workspaces that are not demo workspaces are never purged.

## Other people's sites

The crawler identifies itself honestly, obeys robots.txt, `Crawl-delay` and `Retry-After`, stays on the site you named, and never sends more than six requests at a time to one host.

## Reporting a problem

Report a vulnerability privately through GitHub's private vulnerability reporting on the repository. The [security model](../SECURITY.md) lists the threats considered and the risk that remains for each.
