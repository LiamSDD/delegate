# Policy and approvals

Before any tool runs, three things happen in code, in this order. None of them is a prompt.

1. **Capability check.** A plan step lists the capabilities it may use, and the orchestrator refuses a plan that grants more than the mission allows. A call to a tool whose capability the step does not hold is rejected before the tool is reached.
2. **Policy decision.** The policy engine evaluates the call against the workspace's policies and a built-in baseline, and returns `allow`, `deny` or `require_approval`.
3. **Approval.** A call that requires approval runs only after a person, or an explicit pre-approval, says yes.

Each decision is written to the run's event log as a `policy.decided` event before the tool runs.

## Capabilities

| Capability | Used for | Side effect |
|---|---|---|
| `web.fetch` | Fetching public pages and archives | No |
| `artifact.write` | Publishing a deliverable or a snapshot | No |
| `connector.read` | MCP connector tools marked read-only | No |
| `sandbox.read`, `sandbox.write`, `sandbox.exec` | The Engineer's tools, which reach nothing outside the sandbox | No |
| `connector.write` | Every other MCP connector tool | Yes |
| `repo.write` | Opening a pull request | Yes |
| `scratchpad.write` | Defined in the policy package. No tool uses it yet. | No |
| `code.execute`, `message.send`, `webhook.send` | Defined in the policy package. No tool uses them yet. | Yes |

## The baseline that policies cannot relax

These decisions carry the policy id `builtin`. The strongest decision wins: a deny beats a required approval, which beats an allow. So a workspace policy can add restrictions, and nothing in a policy can remove these.

- A capability with side effects always requires human approval.
- A capability that can make outbound requests must declare its target domain, or the call is denied.
- An IP literal, a local, link-local, metadata or private hostname is never an allowed target.
- An outbound call is denied unless an egress allowlist permits that capability to reach that domain.
- A policy that fails validation is treated as a deny.

## What a policy can say

A policy is a validated object with a list of rules.

| Rule | Effect |
|---|---|
| `capability_allowlist` | Only the listed capabilities may be used in the workspace. |
| `egress_allowlist` | The listed capabilities may reach only the listed domains. |
| `require_approval` | The listed tools need approval. |
| `deny_tools` | The listed tools may not run. |
| `spend_cap` | A cap per run and per day, in micro-dollars, with what to do when it would be exceeded. |
| `classification` | Data of the listed classifications may not be sent to the listed tools or providers. |
| `provider_terms` | Only model providers with the listed terms may serve the run. |

Policies are defined in `packages/policy`. There is no policy editor in the app yet.

### The guest policy

Every run on the public demo is evaluated against `guest-demo`:

- capabilities limited to `web.fetch`, `artifact.write` and `scratchpad.write`;
- outbound requests only through fetch tools, to public hostnames;
- spend capped at zero, per run and per day;
- only providers whose terms allow the public demo, local providers, or your own key;
- confidential and restricted data may not be sent to any tool.

Ship-a-PR adds its own policies. Without a connected GitHub installation, `ship-demo` denies opening a pull request outright, so the result is a patch. With one, `ship-connected` requires approval and keeps spend at zero.

## Approvals

| What waits | Where you decide | If nobody decides |
|---|---|---|
| The plan, before any agent starts | The plan card on the run page, or `approve_plan` and `reject_plan` over MCP | Rejected after 10 minutes. The run stops. |
| A plan revision that adds a capability, or gives a side-effecting capability to a step that did not have it | The same card | Rejected after 10 minutes. The run continues on the plan approved earlier. |
| A connector tool with side effects | An approval card on the run page showing the tool, the server and the arguments | Rejected after 10 minutes. The agent receives a refused call. |
| A Ship-a-PR diff | The approval card on the run page showing the diff and the test results | Nothing is shipped after 10 minutes. |

### What automatic approval covers

Two settings approve the first plan of a run without a click: the **Auto-approve plans** switch on the home page, and **Approve mission plans automatically** on the Connections page, which also applies to runs started over MCP.

They cover the first plan only. A revision that widens the plan's capabilities always waits for a person. They never cover a side effect: a pull request always asks, and a connector tool with side effects asks unless you pre-approved that exact tool definition. See [connect your own MCP servers](connect-mcp-servers.md#pre-approve-a-tool).

Runs with no reviewer attached, such as evals, approve their plan as `system` with a recorded reason, and can never ship.

### What the database enforces

Approvals are not only an application rule. The application role has no `UPDATE` on the approvals table. A decision goes through a function that checks all of the following:

- the caller is a person with at least the operator role in the workspace, not an agent;
- the approval is still pending;
- an operator is not approving an action on a run they created. Owners and admins may, and anyone allowed to decide may reject.

A resolved approval cannot be changed or reopened, by anyone. [Database and row-level security](../../packages/db/README.md) has the details.

## Audit

- Every policy decision is in the run's event log, and https://trydelegate.app/control/audit lists the decisions for your workspace, newest first, each with its run.
- Plan, tool and ship decisions are also written to the append-only `audit_log` table, with who decided.
- Reasons are passed through PII redaction before they are stored.

The engine is deterministic TypeScript with table-driven tests, and the [red-team suite](red-team.md) attacks it with forged approvals, widened plan grants and claims of administrator authority.
