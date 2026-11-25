"use client";

import { useState, type ReactNode, type SyntheticEvent } from "react";

import { clientSnippets, type ClientSnippet } from "@/lib/connection-snippets";
import type { ConnectionsOverview } from "@/server/connections-api";

type Connector = ConnectionsOverview["connectors"][number];
type Token = ConnectionsOverview["tokens"][number];

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

const inputClass =
  "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-text-subtle focus-visible:border-border-strong focus-visible:outline-none";
const primaryButton =
  "inline-flex h-9 items-center justify-center rounded-md bg-text px-4 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50";
const quietButton =
  "inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-sm text-text-muted hover:border-border-strong hover:text-text disabled:opacity-50";

async function send(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof json === "object" &&
      json !== null &&
      "error" in json &&
      typeof json.error === "object" &&
      json.error !== null &&
      "message" in json.error &&
      typeof json.error.message === "string"
        ? json.error.message
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return json;
}

async function reload(): Promise<ConnectionsOverview> {
  return (await send("/api/settings/connections", "GET")) as ConnectionsOverview;
}

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-5 border-t border-border pt-8">
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 id={id} className="text-lg font-medium text-text">
          {title}
        </h2>
        <p className="text-sm text-text-muted text-pretty">{lede}</p>
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  return message === null ? null : (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={quietButton}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function Snippets({ snippets }: { snippets: ClientSnippet[] }) {
  const [active, setActive] = useState<ClientSnippet["id"]>("claude-code");
  const current = snippets.find((snippet) => snippet.id === active) ?? snippets[0];
  if (current === undefined) return null;
  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
      <div
        role="tablist"
        aria-label="MCP client"
        className="flex flex-wrap gap-1 border-b border-border p-2"
      >
        {snippets.map((snippet) => (
          <button
            key={snippet.id}
            type="button"
            role="tab"
            aria-selected={snippet.id === current.id}
            onClick={() => {
              setActive(snippet.id);
            }}
            className={`h-8 rounded-md px-3 text-sm ${
              snippet.id === current.id
                ? "bg-surface-2 text-text"
                : "text-text-muted hover:text-text"
            }`}
          >
            {snippet.client}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-text-muted">{current.where}</p>
          <CopyButton text={current.code} />
        </div>
        <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed text-text">
          {current.code}
        </pre>
        <p className="font-mono text-2xs text-text-subtle">
          Format checked against {current.verifiedAgainst}
        </p>
      </div>
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: Token; onRevoke: (id: string) => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm text-text">
          {token.name} <span className="font-mono text-2xs text-text-subtle">{token.prefix}…</span>
        </p>
        <p className="font-mono text-2xs text-text-subtle">
          created {dateFormat.format(new Date(token.createdAt))} ·{" "}
          {token.lastUsedAt === null
            ? "never used"
            : `last used ${dateFormat.format(new Date(token.lastUsedAt))}`}
        </p>
      </div>
      {token.revokedAt === null ? (
        <button
          type="button"
          className={quietButton}
          onClick={() => {
            onRevoke(token.id);
          }}
        >
          Revoke
        </button>
      ) : (
        <span className="font-mono text-2xs text-danger">revoked</span>
      )}
    </li>
  );
}

function ConnectorCard({
  connector,
  preapproved,
  onTogglePreapproval,
  onRefresh,
  onDelete,
  busy,
}: {
  connector: Connector;
  preapproved: readonly string[];
  onTogglePreapproval: (tool: string, on: boolean) => void;
  onRefresh: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <li className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-mono text-sm text-text">{connector.name}</p>
          <p className="truncate font-mono text-2xs text-text-subtle">
            {connector.url} ·{" "}
            {connector.hasSecret
              ? `${connector.authHeaderName ?? "secret"} (encrypted)`
              : "no secret"}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={quietButton} onClick={onRefresh} disabled={busy}>
            Refresh tools
          </button>
          <button type="button" className={quietButton} onClick={onDelete} disabled={busy}>
            Remove
          </button>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {connector.tools.map((tool) => {
          const fullName = `mcp__${connector.name}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
          return (
            <li key={tool.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-mono text-text">{tool.name}</span>
              {tool.withheld ? (
                <span className="rounded-sm bg-danger-soft px-1.5 font-mono text-2xs text-danger">
                  withheld: description addresses the model
                </span>
              ) : tool.readOnly ? (
                <span className="rounded-sm bg-success-soft px-1.5 font-mono text-2xs text-success">
                  read-only · runs under policy
                </span>
              ) : (
                <label className="inline-flex items-center gap-2 text-text-muted">
                  <span className="rounded-sm bg-warning-soft px-1.5 font-mono text-2xs text-warning">
                    side effects · asks for approval
                  </span>
                  <input
                    type="checkbox"
                    checked={preapproved.includes(fullName)}
                    disabled={busy}
                    onChange={(event) => {
                      onTogglePreapproval(fullName, event.target.checked);
                    }}
                  />
                  <span className="text-xs">pre-approve for automatic use</span>
                </label>
              )}
              {tool.description === "" ? null : (
                <span className="w-full text-xs text-text-subtle">{tool.description}</span>
              )}
            </li>
          );
        })}
        {connector.tools.length === 0 ? (
          <li className="text-sm text-text-subtle">This server lists no tools.</li>
        ) : null}
      </ul>
    </li>
  );
}

export function ConnectionsPanel({
  initial,
  origin,
}: {
  initial: ConnectionsOverview;
  origin: string;
}) {
  const [overview, setOverview] = useState(initial);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [error, setError] = useState<{ section: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connectorForm, setConnectorForm] = useState({
    name: "",
    url: "",
    authType: "none" as "none" | "bearer" | "header",
    headerName: "",
    secret: "",
  });

  const run = async (section: string, action: () => Promise<void>) => {
    setBusy(section);
    setError(null);
    try {
      await action();
      setOverview(await reload());
    } catch (failure) {
      setError({ section, message: failure instanceof Error ? failure.message : "Failed" });
    } finally {
      setBusy(null);
    }
  };

  const errorFor = (section: string) => (error?.section === section ? error.message : null);

  const createToken = (event: SyntheticEvent) => {
    event.preventDefault();
    void run("tokens", async () => {
      const created = (await send("/api/settings/tokens", "POST", {
        name: tokenName.trim() || "MCP client",
      })) as { token: string };
      setFreshToken(created.token);
      setTokenName("");
    });
  };

  const addConnector = (event: SyntheticEvent) => {
    event.preventDefault();
    const { name, url, authType, headerName, secret } = connectorForm;
    void run("connectors", async () => {
      await send("/api/settings/connectors", "POST", {
        name,
        url,
        ...(authType === "bearer" ? { auth: { type: "bearer", token: secret } } : {}),
        ...(authType === "header"
          ? { auth: { type: "header", name: headerName, value: secret } }
          : {}),
      });
      setConnectorForm({ name: "", url: "", authType: "none", headerName: "", secret: "" });
    });
  };

  const setPreapproval = (tool: string, on: boolean) => {
    const current = overview.automation.preapprovedTools;
    const next = on ? [...new Set([...current, tool])] : current.filter((name) => name !== tool);
    void run("connectors", async () => {
      await send("/api/settings/automation", "PUT", { preapprovedTools: next });
    });
  };

  return (
    <div className="flex flex-col gap-12">
      <Section
        id="mcp-server"
        title="Use Delegate from Claude Code, Codex or any MCP client"
        lede="Create an API token for this workspace, then add Delegate as a remote MCP server. Runs started from your terminal appear live here. Tokens are shown once, stored only as a SHA-256 hash, and can be revoked at any time."
      >
        <form onSubmit={createToken} className="flex max-w-xl flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm text-text-muted">
            Token name
            <input
              className={inputClass}
              value={tokenName}
              maxLength={80}
              placeholder="e.g. Claude Code on my laptop"
              onChange={(event) => {
                setTokenName(event.target.value);
              }}
            />
          </label>
          <button type="submit" className={primaryButton} disabled={busy === "tokens"}>
            Create token
          </button>
        </form>
        <ErrorLine message={errorFor("tokens")} />
        {freshToken === null ? null : (
          <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft p-4">
            <p className="text-sm text-text">
              Copy this token now. Delegate does not store it and cannot show it again.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs break-all text-text">
                {freshToken}
              </code>
              <CopyButton text={freshToken} label="Copy token" />
            </div>
          </div>
        )}
        <Snippets snippets={clientSnippets(origin, freshToken ?? undefined)} />
        {overview.tokens.length === 0 ? null : (
          <ul className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
            {overview.tokens.map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                onRevoke={(id) => {
                  void run("tokens", async () => {
                    await send(`/api/settings/tokens/${id}`, "DELETE");
                  });
                }}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="connectors"
        title="Your MCP servers"
        lede="Add remote MCP servers (Streamable HTTP). Delegate lists their tools on connect. Read-only tools run under your policies; every other tool asks for approval unless you pre-approve it here. Tool output is read by the quarantined reader, never passed raw to an agent."
      >
        {overview.encryptionConfigured ? null : (
          <p className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
            DELEGATE_ENCRYPTION_KEY is not set on this deployment, so connectors that need a secret
            cannot be added. Servers without credentials still work.
          </p>
        )}
        <form onSubmit={addConnector} className="grid max-w-3xl gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm text-text-muted">
            Name
            <input
              className={inputClass}
              required
              pattern="[a-z0-9][a-z0-9-]{0,31}"
              placeholder="tickets"
              value={connectorForm.name}
              onChange={(event) => {
                setConnectorForm({ ...connectorForm, name: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-text-muted">
            Server URL
            <input
              className={inputClass}
              required
              type="url"
              placeholder="https://mcp.example.com/mcp"
              value={connectorForm.url}
              onChange={(event) => {
                setConnectorForm({ ...connectorForm, url: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-text-muted">
            Credentials
            <select
              className={inputClass}
              value={connectorForm.authType}
              onChange={(event) => {
                const authType = event.target.value;
                if (authType === "none" || authType === "bearer" || authType === "header")
                  setConnectorForm({ ...connectorForm, authType });
              }}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </label>
          {connectorForm.authType === "none" ? (
            <div aria-hidden="true" />
          ) : (
            <div className="flex gap-3">
              {connectorForm.authType === "header" ? (
                <label className="flex w-40 flex-col gap-1.5 text-sm text-text-muted">
                  Header
                  <input
                    className={inputClass}
                    required
                    placeholder="X-Api-Key"
                    value={connectorForm.headerName}
                    onChange={(event) => {
                      setConnectorForm({ ...connectorForm, headerName: event.target.value });
                    }}
                  />
                </label>
              ) : null}
              <label className="flex flex-1 flex-col gap-1.5 text-sm text-text-muted">
                Secret (encrypted at rest)
                <input
                  className={inputClass}
                  required
                  type="password"
                  autoComplete="off"
                  value={connectorForm.secret}
                  onChange={(event) => {
                    setConnectorForm({ ...connectorForm, secret: event.target.value });
                  }}
                />
              </label>
            </div>
          )}
          <div className="md:col-span-2">
            <button type="submit" className={primaryButton} disabled={busy === "connectors"}>
              {busy === "connectors" ? "Connecting…" : "Connect and list tools"}
            </button>
          </div>
        </form>
        <ErrorLine message={errorFor("connectors")} />
        {overview.connectors.length === 0 ? (
          <p className="text-sm text-text-subtle">No MCP servers connected yet.</p>
        ) : (
          <ul className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
            {overview.connectors.map((connector) => (
              <ConnectorCard
                key={connector.id}
                connector={connector}
                preapproved={overview.automation.preapprovedTools}
                busy={busy === "connectors"}
                onTogglePreapproval={setPreapproval}
                onRefresh={() => {
                  void run("connectors", async () => {
                    await send(`/api/settings/connectors/${connector.id}`, "POST");
                  });
                }}
                onDelete={() => {
                  void run("connectors", async () => {
                    await send(`/api/settings/connectors/${connector.id}`, "DELETE");
                  });
                }}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="github"
        title="GitHub"
        lede="Authorize the Delegate GitHub App, then install it on the repositories it may open pull requests on. Delegate verifies with GitHub that you can access the installation before linking it to this workspace, and does not keep your GitHub user token."
      >
        {overview.github.configured ? (
          <div className="flex flex-wrap gap-3">
            <a href="/api/github/connect" className={primaryButton}>
              Connect GitHub
            </a>
            {overview.github.installUrl === null ? null : (
              <a href={overview.github.installUrl} className={quietButton + " h-9"}>
                Install on repositories
              </a>
            )}
          </div>
        ) : (
          <p className="text-sm text-text-subtle">
            This deployment has no GitHub App configured (GITHUB_APP_CLIENT_ID,
            GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG). Pull requests fall back to downloadable
            patches.
          </p>
        )}
        <ErrorLine message={errorFor("github")} />
        {overview.github.installations.length === 0 ? null : (
          <ul className="flex flex-col rounded-xl border border-border bg-surface shadow-sm">
            {overview.github.installations.map((installation) => (
              <li
                key={installation.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="font-mono text-sm text-text">{installation.accountLogin}</p>
                  <p className="font-mono text-2xs text-text-subtle">
                    {installation.repositorySelection === "all"
                      ? "all repositories"
                      : `${installation.repositories.length} selected: ${installation.repositories.slice(0, 4).join(", ")}${installation.repositories.length > 4 ? "…" : ""}`}
                  </p>
                </div>
                <button
                  type="button"
                  className={quietButton}
                  onClick={() => {
                    void run("github", async () => {
                      await send(`/api/settings/github/${installation.id}`, "DELETE");
                    });
                  }}
                >
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="automation"
        title="Automation"
        lede="Defaults for runs in this workspace, including runs started over MCP. Pre-approved connector tools are chosen per tool above; every automatic approval is still written to the run log and the audit view."
      >
        <label className="inline-flex items-center gap-3 text-sm text-text">
          <input
            type="checkbox"
            checked={overview.automation.autoApprovePlans}
            disabled={busy === "automation"}
            onChange={(event) => {
              const autoApprovePlans = event.target.checked;
              void run("automation", async () => {
                await send("/api/settings/automation", "PUT", { autoApprovePlans });
              });
            }}
          />
          Approve mission plans automatically
        </label>
        <p className="text-sm text-text-muted">
          {overview.automation.preapprovedTools.length === 0
            ? "No connector tools are pre-approved: every side effect asks first."
            : `Pre-approved: ${overview.automation.preapprovedTools.join(", ")}`}
        </p>
        <ErrorLine message={errorFor("automation")} />
      </Section>
    </div>
  );
}
