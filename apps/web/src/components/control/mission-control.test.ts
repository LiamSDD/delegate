import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ControlLoading from "@/app/control/loading";
import { emptyMissionControl } from "@/server/control/overview";
import { GUEST_RUNS_PER_HOUR } from "@/server/session";

import { ApprovalsInbox, prettyArguments } from "./approvals-inbox";
import { inboxAction, SHIP_NEEDS_THE_DIFF } from "./inbox-actions";
import { CONTROL_SECTIONS, MissionControlView } from "./mission-control";
import { phoneWidthProblems } from "./phone-markup";
import { busyMissionControl, FIXTURE_NOW, fullArguments, inboxItems } from "./test-fixtures";

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
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

function emptyStates(html: string): number {
  return html.split("data-empty-state").length - 1;
}

describe("Mission Control with nothing in the workspace", () => {
  const html = renderToString(
    createElement(MissionControlView, { control: emptyMissionControl(FIXTURE_NOW) }),
  );
  const page = text(html);

  it("says there is no workspace yet and where one comes from", () => {
    expect(page).toContain("This browser has no workspace yet");
    expect(html).toContain('href="/?focus=mission"');
  });

  it("gives every list an empty state that says what will appear", () => {
    expect(emptyStates(html)).toBe(3);
    expect(page).toContain("Nothing is waiting for you");
    expect(page).toContain("a connector tool call with its full arguments");
    expect(page).toContain("No runs are active");
    expect(page).toContain("with its mission, target, current step, elapsed time and tokens");
    expect(page).toContain("No policy decisions yet");
    expect(page).toContain("Its newest decisions for this workspace appear here");
  });

  it("states every usage figure as zero with its unit and time window", () => {
    expect(page).toContain(
      `0 of ${String(GUEST_RUNS_PER_HOUR)} runs started in the last 60 minutes`,
    );
    expect(page).toContain("Last 7 days, since 18 Nov 2026");
    expect(page).toContain("No run started in the last 7 days");
    expect(page).toContain("0 times a model call moved down the chain");
    expect(page).toContain("0.0 s wall-clock, across 0 sandbox commands");
    expect(page).toContain("5 hours of Active CPU a month on Vercel Hobby");
    expect(html).toContain('href="https://vercel.com/docs/sandbox/pricing"');
    expect(page).toContain("0 pages fetched by crawl tools");
  });

  it("keeps the switches visible but unusable, and links to the audit log", () => {
    expect(page).toContain("Pause new runs");
    expect(page).toContain("Available once this browser has a workspace");
    expect(page).toContain("Nothing is running, so nothing to stop.");
    expect(html).toContain('href="/control/audit"');
    expect(html).not.toContain("data-paused-banner");
  });
});

describe("Mission Control with work in progress", () => {
  const control = busyMissionControl();
  const html = renderToString(createElement(MissionControlView, { control }));
  const page = text(html);

  it("lists the sections in the order an operator needs them", () => {
    const positions = CONTROL_SECTIONS.map((section) => html.indexOf(`id="${section.id}"`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("shows each active run with mission, target, step, tokens, a Stop button and its link", () => {
    expect(page).toContain("Repo X-ray");
    expect(page).toContain("acme/a-repository-with-quite-a-long-name-for-a-monorepo");
    expect(page).toContain("run-the-test-suite-in-the-sandbox · in progress");
    expect(page).toContain("18,420");
    expect(page).toContain("Simulated");
    expect(page).toContain("Stalled");
    expect(html).toContain('href="/runs/44444444-4444-4444-8444-444444444444"');
    expect(html).toContain(
      'aria-label="Stop acme/a-repository-with-quite-a-long-name-for-a-monorepo"',
    );
    expect(page).toContain("Showing the newest 50 active runs");
  });

  it("nests an Autopilot run's steps under it and offers Stop only for unfinished ones", () => {
    expect(page).toContain("Steps this Autopilot run started (2)");
    const finishedChild = html.slice(
      html.indexOf('data-run="22222222-2222-4222-8222-222222222222"'),
      html.indexOf('data-run="33333333-3333-4333-8333-333333333333"'),
    );
    expect(finishedChild).toContain("Completed");
    expect(finishedChild).not.toContain("Stop acme.example");
    expect(page).toContain("3 runs active");
  });

  it("puts all three approval kinds in one inbox with the time left", () => {
    expect(html.split('data-approval="plan"').length - 1).toBe(1);
    expect(html.split('data-approval="tool"').length - 1).toBe(2);
    expect(html.split('data-approval="ship"').length - 1).toBe(1);
    expect(page).toContain("4 requests pending");
    expect(page).toContain("7 min 00 s left");
    expect(page).toContain("1 min 30 s left");
    expect(page).toContain("12 min 00 s left");
    expect(page).toContain("Showing the 100 most recent requests");
  });

  it("shows a plan step by step and approves exactly those steps", () => {
    expect(page).toContain("Run this plan of 2 steps?");
    expect(page).toContain("Map the public site and list the product pages worth reading.");
    expect(page).toContain("draft-audit · after map-site · 60% of budget");
    expect(page).toContain("Approve these steps");
  });

  it("shows a connector call's full arguments and the hash that will be sent", () => {
    const tool = inboxItems[1];
    if (tool?.kind !== "tool") throw new Error("fixture changed");
    expect(html).toContain(
      prettyArguments(fullArguments).replace(/&/g, "&amp;").replace(/"/g, "&quot;"),
    );
    expect(page).toContain(`sha256 ${tool.argsSha256}`);
    expect(page).toContain("Approve this call");
    expect(inboxAction(tool, "approved")).toEqual({
      via: "request",
      url: `/api/runs/${tool.runId}/tool-approval`,
      body: { approvalId: "ap_1", decision: "approved", argsSha256: tool.argsSha256 },
    });
  });

  it("summarises a ship diff, links to the full diff and never offers a blind approval", () => {
    const start = html.indexOf('data-approval="ship"');
    const ship = html.slice(start, html.indexOf("</li>", html.indexOf("Open run", start)));
    const shown = text(ship);
    expect(shown).toContain("Open a pull request on acme/widget?");
    expect(shown).toContain("3 files · +42 −7 lines");
    expect(shown).toContain("delegate/fix-the-flaky-retry-test-in-the-payments-client → main");
    expect(shown).toContain("failed (exit 1) → passed");
    expect(shown).toContain(SHIP_NEEDS_THE_DIFF);
    expect(shown).toContain("Review the full diff");
    expect(ship).toContain('href="/runs/66666666-6666-4666-8666-666666666666"');
    expect(shown).not.toContain("Approve");
    expect(shown).toContain("Reject");
  });

  it("offers no decision for a request past its deadline", () => {
    const start = html.lastIndexOf('data-approval="tool"');
    const late = text(html.slice(start, html.indexOf("</li>", html.indexOf("Open run", start))));
    expect(late).toContain("Past its deadline");
    expect(late).toContain("Open the run to see what happened to it.");
    expect(late).not.toContain("Approve this call");
    expect(late).not.toContain("Reject");
  });

  it("expires a request on the client clock without waiting for the next refresh", () => {
    const [plan] = inboxItems;
    if (plan === undefined) throw new Error("fixture changed");
    const later = Date.parse(plan.expiresAt) + 1_000;
    const late = text(
      renderToString(
        createElement(ApprovalsInbox, {
          items: [plan],
          truncated: false,
          limit: 100,
          renderedAt: later,
        }),
      ),
    );
    expect(late).toContain("Past its deadline");
    expect(late).not.toContain("Approve these steps");
  });

  it("gives every usage number a unit and a window", () => {
    expect(page).toContain(
      `5 of ${String(GUEST_RUNS_PER_HOUR)} runs started in the last 60 minutes`,
    );
    expect(page).toContain("9 runs started today, since 25 Nov 2026, 00:00 UTC");
    expect(page).toContain("1,725,568 tokens, input plus output");
    expect(page).toContain("1,204,331");
    expect(page).toContain("4 times a model call moved down the chain");
    expect(page).toContain("1 of them had no model left to fall back to.");
    expect(page).toContain("13 min 32 s wall-clock, across 14 sandbox commands");
    expect(page).toContain("0.2 h logged here is an upper bound");
    expect(page).toContain("137 pages fetched by crawl tools");
    expect(page).toContain("1 site crawl did not report a page count and is not in this figure.");
  });

  it("says that new runs are paused and lists what the switches did", () => {
    expect(html).toContain("data-paused-banner");
    expect(page).toContain("New runs are paused for this workspace since 25 Nov 2026, 11:30 UTC");
    expect(page).toContain("Resume new runs");
    expect(page).toContain("Stop all active runs…");
    expect(page).toContain("All active runs stopped (2 runs)");
  });

  it("lists recent policy decisions with their totals and the audit link", () => {
    expect(page).toContain("Needs approval");
    expect(page).toContain("policy guest-demo+connectors · Custom goal");
    expect(page).toContain(
      "The newest 2 of 220 decisions: 212 allowed, 3 denied, 5 sent for approval.",
    );
    expect(html).toContain('href="/control/audit"');
  });
});

describe("Mission Control while loading", () => {
  const html = renderToString(createElement(ControlLoading));

  it("is marked busy, names what it is doing and keeps the section headings in place", () => {
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(text(html)).toContain("Reading the run log…");
    for (const section of CONTROL_SECTIONS) expect(text(html)).toContain(section.title);
    expect(html).not.toContain("data-empty-state");
  });
});

describe("Mission Control at phone width", () => {
  it.each([
    [
      "empty",
      () => createElement(MissionControlView, { control: emptyMissionControl(FIXTURE_NOW) }),
    ],
    ["busy", () => createElement(MissionControlView, { control: busyMissionControl() })],
    ["loading", () => createElement(ControlLoading)],
  ])("the %s page has nothing that forces horizontal scrolling", (_name, element) => {
    expect(phoneWidthProblems(renderToString(element()))).toEqual([]);
  });
});
