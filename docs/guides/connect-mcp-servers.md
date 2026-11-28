# Connect your own MCP servers

A connector is a remote MCP server that you add to your workspace. Its tools become available to runs, so a custom goal can read from your ticket system, your wiki or your own API. Delegate treats the server as untrusted: its output is read in quarantine, its tool descriptions are screened, and any tool that can change something waits for approval.

## Add a server

Open https://trydelegate.app/settings/connections and go to **Your MCP servers**.

| Field | Rules |
|---|---|
| Name | Lowercase letters, digits and hyphens, 1 to 32 characters, starting with a letter or digit. It becomes part of each tool's name. |
| Server URL | A Streamable HTTP endpoint, at most 2,048 characters. No credentials in the URL, no IP addresses, no local, `.internal` or metadata hostnames, and only ports 80 and 443. In production the URL must use `https`. |
| Credentials | None, a bearer token, or a custom header with a secret value. |

Choose **Connect and list tools**. Delegate connects with a 10-second timeout, resolves and checks the server's DNS at connect time, refuses redirects, and lists the tools the server offers.

A workspace can have at most 10 connectors, and Delegate keeps at most 50 tools per connector.

### Secrets

A secret is encrypted with AES-256-GCM before it is stored, with the connector's id bound into the ciphertext so it cannot be moved to another row. It is never returned to the browser, never logged and never sent to a model.

Encryption needs `DELEGATE_ENCRYPTION_KEY` on the deployment. Without it, the page says so and refuses a connector that needs a secret. Servers without credentials still work.

## What each tool is allowed to do

Each tool is registered for runs as `mcp__<connector>__<tool>` and falls into one of three groups, shown next to it in settings.

| Shown as | When | Effect |
|---|---|---|
| read-only · runs under policy | The server marks the tool `readOnlyHint: true` | It gets the `connector.read` capability and runs under the workspace policies, with egress limited to the connector's own host. |
| side effects · asks for approval | Everything else | It gets `connector.write`, a side-effect capability. The policy baseline returns "requires approval" for every call, whatever the workspace policies say. |
| withheld: description addresses the model | The tool's name or description trips the injection detector | It is not registered. A description is attacker-controlled text that would otherwise land in a model's tool list. |

Descriptions are normalised and cut to 200 characters before they are screened or shown. The read-only decision never looks at the description.

## Approvals

When an agent calls a side-effecting tool, the run pauses and its page shows an approval card with the tool, the server and the arguments. The arguments shown are the full canonical ones, and the decision is bound to their SHA-256 hash, so what you approve is what runs. Calls whose arguments exceed 32 KB are refused.

If nobody decides within 10 minutes, the call is rejected. A rejection goes back to the agent as a refused call, and nothing runs.

### Pre-approve a tool

Tick **pre-approve for automatic use** next to a side-effecting tool to let runs call it without a click. The approval is still written to the run log and the audit view, as made by `system:workspace-preapproval`.

A pre-approval is bound to the connector and to a hash of the tool's definition: its name, description, input schema and read-only flag. If **Refresh tools** brings back a changed definition, the pre-approval stops applying and settings mark the tool "changed since approved" until you approve it again. Removing a connector clears its pre-approvals. Text in a tool's output cannot add to the list, because the list is read from the database when the run starts.

## What comes back from a tool

Tool output never reaches a privileged model raw.

- A call may take at most 20 seconds and return at most 64 KB of text.
- The output is stored as an artifact for the trace after PII redaction.
- The [quarantined reader](quarantined-reader.md) reads it and returns typed facts, each with a verbatim quote tagged `untrusted`, plus a flag when the output looks like it is trying to instruct a model.
- Each call is recorded as a `connector.call` event with the server, the tool, the duration, the size and a redacted summary.

## Where connectors are used

The custom-goal mission adds a `use_connectors` step when the workspace has connectors. The agent in that step may make at most six tool calls, and each result becomes a source of kind `connector` whose facts feed the brief and the critic.

The public-research missions do not get connectors. Company X-ray and the audit are about public sources, and mixing private workspace data into a public brief would blur its citations.

## What this does not protect against

A server that marks a tool `readOnlyHint: true` when it actually has side effects bypasses the approval gate for that tool. You chose to add the server, its calls can only reach its own host, and its output still goes through quarantine. This is recorded as residual risk T11 in the [security model](../SECURITY.md#threats). ADR 0014 has the full design.
