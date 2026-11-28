# Security policy

Delegate lets models read untrusted content and act with tools, so it treats prompt injection, tenant isolation and side effects as security boundaries. The full security and threat model, with every control and the test that covers it, is in [`docs/SECURITY.md`](docs/SECURITY.md).

## Supported versions

Delegate is pre-1.0. Fixes land on `main` and in the next release; older releases are not patched. The live demo is [trydelegate.app](https://trydelegate.app).

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/LiamSDD/delegate/security/advisories/new) (the **Security** tab, then **Report a vulnerability**). Do not open a public issue, pull request or discussion. There is no email contact; private reporting is the only channel.

Include what you can of:

- the mission, route or API call involved, and whether you used the live demo or a local run;
- the input, page or connector content that triggers it, and the run id if there is one;
- what happened and what you expected, for example a tool call that should have needed approval.

Test against a local run (`pnpm dev`) where you can. On the live demo, use only your own guest workspace, do not try to reach other people's data, and do not run load or denial-of-service tests.

You should get an acknowledgement within 7 days. Once the issue is confirmed, the fix ships with a regression test (and a red-team case where it fits), and a GitHub security advisory credits you unless you ask not to be.

## Scope

In scope, among others:

- **Prompt injection that leads to an action**: untrusted web, upload, repository or connector content that reaches a privileged agent raw, or makes a tool call that the plan did not grant or that skipped approval.
- **Tenant isolation**: reading or changing another workspace's data, or any way around row-level security.
- **Approval and policy bypasses**: side effects (pull requests, messages, webhooks, connector writes) without the approval the policy requires.
- **SSRF and fetch hardening**: reaching private, loopback, link-local or metadata addresses, including through redirects or DNS rebinding.
- **Sandbox escapes** from the code-execution sandbox, and leaks of tokens or secrets to models, logs, events or the browser.
- **Authentication**: API token, session, webhook signature or GitHub connect flaws.

Out of scope:

- Wrong or weak answers from a model with no security impact; open a regular issue.
- Rate limits and outages of the free community model providers.
- Findings that need an attacker who already controls the server, the database or the owner's accounts.
