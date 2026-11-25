import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import AutomationLoading from "@/app/settings/automation/loading";
import DataLoading from "@/app/settings/data/loading";
import SettingsLoading from "@/app/settings/loading";
import PoliciesLoading from "@/app/settings/policies/loading";
import { phoneWidthProblems } from "@/components/control/phone-markup";
import { NO_WORKSPACE_FACTS, type PolicyFacts } from "@/server/control/policies";
import type { WorkspaceOverview } from "@/server/control/workspace";
import { DELETE_CONFIRMATION, isConfirmed } from "@/server/data/delete";
import { EXPORT_MAX_BYTES, EXPORT_MAX_DURATION_MS, EXPORTS_PER_HOUR } from "@/server/data/export";
import { EMPTY_INVENTORY } from "@/server/data/inventory";

import { AutomationView, NO_AUTOMATION } from "./automation-view";
import { DataView, parseExportOutcome } from "./data-view";
import { normaliseConfirmation, removedLabel } from "./delete-data-form";
import { SettingsOverview } from "./overview";
import { PoliciesView } from "./policies-view";
import { SETTINGS_PAGES } from "./settings-frame";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

function text(html: string): string {
  return html
    .replace(/<!--.*?-->/gs, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const LONG_HOST = "tickets.a-very-long-subdomain-name.internal-tools.example-corporation.com";

const workspace: WorkspaceOverview = {
  id: "0b0f3c52-7a53-4d0e-9a55-6f1f2f6f7a10",
  name: "Guest workspace",
  tier: "guest",
  demo: true,
  role: "owner",
  createdAt: new Date("2026-11-20T09:15:00.000Z"),
  retentionDays: 7,
  runsPausedAt: null,
  connectors: 0,
  githubInstallations: 0,
};

const guestFacts: PolicyFacts = { audience: "public-demo", ...NO_WORKSPACE_FACTS };

const connectedFacts: PolicyFacts = {
  audience: "public-demo",
  tier: "connected",
  connectorHosts: [LONG_HOST],
  connectorTools: [
    {
      name: "mcp__tickets__add_comment_to_an_existing_support_ticket",
      readOnly: false,
      host: LONG_HOST,
    },
    { name: "mcp__tickets__search", readOnly: true, host: LONG_HOST },
  ],
};

const exportFacts = {
  maxBytes: EXPORT_MAX_BYTES,
  maxSeconds: EXPORT_MAX_DURATION_MS / 1000,
  perHour: EXPORTS_PER_HOUR,
};

const dataProps = {
  inventory: EMPTY_INVENTORY,
  hasWorkspace: false,
  exportFacts,
  exportOutcome: null,
  deletePhrase: DELETE_CONFIRMATION,
};

const busyInventory = {
  runs: 12,
  events: 4_812,
  artifacts: 31,
  assistants: 1,
  connectors: 2,
  githubInstallations: 1,
  apiTokens: 3,
  settings: 1,
};

const preapproved = {
  autoApprovePlans: true,
  preapprovedTools: ["mcp__tickets__add_comment_to_an_existing_support_ticket"],
  changedTools: ["mcp__crm__update_contact_record_with_a_changed_definition"],
};

describe("settings overview", () => {
  it("replaces the placeholder with the workspace's id, kind, creation date and retention", () => {
    const html = renderToString(createElement(SettingsOverview, { workspace }));
    const page = text(html);
    expect(page).not.toContain("arrives in");
    expect(page).toContain(workspace.id);
    expect(page).toContain("Guest");
    expect(page).toContain("20 Nov 2026, 09:15 UTC");
    expect(page).toContain("7 days. A run, with its events, artifacts and audit entries");
    expect(page).toContain("owner");
  });

  it("calls a workspace with a connector or GitHub link connected", () => {
    const page = text(
      renderToString(
        createElement(SettingsOverview, {
          workspace: { ...workspace, tier: "connected", connectors: 1, githubInstallations: 2 },
        }),
      ),
    );
    expect(page).toContain("Connected");
    expect(page).toContain("1 MCP connector and 2 GitHub installations linked");
  });

  it("links to every settings page, webhooks and automation included, and offers the theme", () => {
    const html = renderToString(createElement(SettingsOverview, { workspace }));
    for (const page of SETTINGS_PAGES) expect(html).toContain(`href="${page.href}"`);
    expect(html).toContain('href="/settings/webhooks"');
    expect(html).toContain('href="/settings/connections"');
    expect(html).toContain('href="/settings/automation"');
    expect(text(html)).toContain("Match the system");
    expect(html).toContain('aria-current="page"');
  });

  it("explains what will be listed when the browser has no workspace", () => {
    const html = renderToString(createElement(SettingsOverview, { workspace: null }));
    expect(html).toContain("data-empty-state");
    expect(text(html)).toContain("No workspace yet");
    expect(text(html)).toContain("Its id, kind, creation date and retention period will be listed");
  });
});

describe("settings policies", () => {
  it("shows the guest demo set read-only with its rules and where it applies", () => {
    const html = renderToString(createElement(PoliciesView, { facts: guestFacts }));
    const page = text(html);
    expect(html).toContain('data-policy="guest-demo"');
    expect(page).toContain("Guest demo workspace");
    expect(page).toContain("read-only");
    expect(page).toContain("read-only-capabilities");
    expect(page).toContain("A tool call is denied unless its capability is one of:");
    expect(page).toContain("web.fetch");
    expect(page).toContain("At most $0.00 per run and $0.00 per day");
    expect(page).toContain("Started by you (web app, API or MCP)");
    expect(page).toContain("Started as a step of an Autopilot run");
    expect(page).toContain("no connector hosts");
    expect(html).not.toContain("guest-demo+connectors");
  });

  it("shows the connector variant with the workspace's connector hosts", () => {
    const html = renderToString(createElement(PoliciesView, { facts: connectedFacts }));
    expect(html).toContain('data-policy="guest-demo+connectors"');
    expect(text(html)).toContain("connector-hosts");
    expect(text(html)).toContain(LONG_HOST);
  });

  it("offers the simulator with every mission, capability and known tool, and an empty result", () => {
    const html = renderToString(createElement(PoliciesView, { facts: connectedFacts }));
    const page = text(html);
    for (const mission of ["Company X-ray", "Repo X-ray", "Ship-a-PR"])
      expect(page).toContain(mission);
    expect(html).toContain('<option value="connector.write">');
    expect(html).toContain('<option value="github.open_pr">');
    expect(html).toContain(
      '<option value="mcp__tickets__add_comment_to_an_existing_support_ticket">',
    );
    expect(page).toContain("The call has a side effect");
    expect(page).toContain("Run the dry run");
    expect(page).toContain("The decision will appear here");
    expect(page).toContain("No model is called");
  });
});

describe("settings data", () => {
  it("has an empty state and disabled actions without a workspace", () => {
    const html = renderToString(createElement(DataView, dataProps));
    const page = text(html);
    expect(html).toContain("data-empty-state");
    expect(page).toContain("This workspace holds no data yet");
    expect(page).toContain("there is nothing to export");
    expect(page).toContain("there is nothing to delete");
    expect(html.split("disabled").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("counts what the workspace holds and states the export cap from the server constants", () => {
    const html = renderToString(
      createElement(DataView, { ...dataProps, inventory: busyInventory, hasWorkspace: true }),
    );
    const page = text(html);
    expect(page).toContain("4,812 run events");
    expect(page).toContain("1 assistant");
    expect(page).toContain("3 API tokens");
    expect(page).toContain("The file stops at 32 MiB or 240 seconds");
    expect(page).toContain("says why and which runs are missing or incomplete");
    expect(page).toContain("Up to 6 exports an hour");
    expect(html).toMatch(/<form [^>]*action="\/settings\/data\/export" method="post"/);
    expect(html).not.toContain("data-empty-state");
  });

  it("asks for the server's phrase before deleting and says what is kept", () => {
    const page = text(
      renderToString(
        createElement(DataView, { ...dataProps, inventory: busyInventory, hasWorkspace: true }),
      ),
    );
    expect(page).toContain(`Type ${DELETE_CONFIRMATION} to confirm`);
    expect(page).toContain("Delete my data permanently");
    expect(page).toContain("It cannot be undone");
    expect(page).toContain("That entry is the only thing kept");
  });

  it("accepts in the browser exactly what the server accepts as confirmation", () => {
    for (const typed of ["delete my data", "  Delete   My Data ", "delete my data.", "delete", ""])
      expect(normaliseConfirmation(typed) === DELETE_CONFIRMATION).toBe(isConfirmed(typed));
  });

  it("names what a deletion removed, one or many, and passes an unknown kind through", () => {
    expect(removedLabel("settings", 1)).toBe("settings record");
    expect(removedLabel("events", 64)).toBe("run events");
    expect(removedLabel("somethingNew", 2)).toBe("somethingNew");
  });

  it("explains an export that was turned away", () => {
    expect(parseExportOutcome("rate_limited")).toBe("rate_limited");
    expect(parseExportOutcome(["nothing", "x"])).toBe("nothing");
    expect(parseExportOutcome("anything")).toBeNull();
    expect(parseExportOutcome(undefined)).toBeNull();
    const page = text(
      renderToString(createElement(DataView, { ...dataProps, exportOutcome: "rate_limited" })),
    );
    expect(page).toContain("too many exports in an hour");
  });
});

describe("settings automation", () => {
  it("shows the defaults off, with an empty state for pre-approved tools", () => {
    const html = renderToString(createElement(AutomationView, { automation: NO_AUTOMATION }));
    const page = text(html);
    expect(page).toContain("Ask every time");
    expect(page).toContain("Approve mission plans automatically");
    expect(html).toContain("data-empty-state");
    expect(page).toContain("No connector tool is pre-approved");
    expect(html).toContain('href="/settings/connections#connectors"');
    expect(html).toContain('href="/control#approvals"');
  });

  it("lists pre-approved tools with a way to withdraw each, and the ones that changed", () => {
    const html = renderToString(createElement(AutomationView, { automation: preapproved }));
    const page = text(html);
    expect(page).toContain("Approved automatically");
    expect(page).toContain("1 pre-approved");
    expect(page).toContain("mcp__tickets__add_comment_to_an_existing_support_ticket");
    expect(page).toContain("Ask again for this tool");
    expect(page).toContain("mcp__crm__update_contact_record_with_a_changed_definition");
    expect(html).not.toContain("data-empty-state");
  });
});

const loadingPages: [string, () => ReactElement, string][] = [
  ["/settings", () => createElement(SettingsLoading), "Reading your workspace…"],
  [
    "/settings/policies",
    () => createElement(PoliciesLoading),
    "Reading the policy sets for this workspace…",
  ],
  ["/settings/data", () => createElement(DataLoading), "Counting what this workspace holds…"],
  [
    "/settings/automation",
    () => createElement(AutomationLoading),
    "Reading the automation defaults…",
  ],
];

describe("settings while loading", () => {
  it.each(loadingPages)("%s is marked busy and says what it is reading", (_path, page, reading) => {
    const html = renderToString(page());
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(text(html)).toContain(reading);
    expect(html).not.toContain("data-empty-state");
  });
});

describe("settings at phone width", () => {
  const pages: [string, () => ReactElement][] = [
    ["overview", () => createElement(SettingsOverview, { workspace })],
    ["overview without a workspace", () => createElement(SettingsOverview, { workspace: null })],
    ["policies", () => createElement(PoliciesView, { facts: connectedFacts })],
    ["data, empty", () => createElement(DataView, dataProps)],
    [
      "data, in use",
      () => createElement(DataView, { ...dataProps, inventory: busyInventory, hasWorkspace: true }),
    ],
    ["automation, empty", () => createElement(AutomationView, { automation: NO_AUTOMATION })],
    ["automation, in use", () => createElement(AutomationView, { automation: preapproved })],
    ...loadingPages.map(([path, page]): [string, () => ReactElement] => [`${path} loading`, page]),
  ];

  it.each(pages)("%s has nothing that forces horizontal scrolling", (_name, page) => {
    expect(phoneWidthProblems(renderToString(page()))).toEqual([]);
  });
});
