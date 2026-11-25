import {
  AUTOPILOT_LIMITS,
  DIFF_LIMITS,
  GOAL_LIMITS,
  GOAL_MAX_CHARS,
  GOAL_STEP_LIMITS,
  MAX_FORK_OBJECTIVE_CHARS,
  XRAY_LIMITS,
} from "@delegate/runtime";
import { STDIO_MISSIONS, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS } from "@delegate/mcp-server";
import { describe, expect, it } from "vitest";

import { clientSnippets } from "@/lib/connection-snippets";
import { MAX_INPUT_LENGTH } from "@/lib/detect-mission";
import { REPLAY_SPEEDS } from "@/lib/runs/replay";
import { MAX_ACTIVE_TOKENS } from "@/server/api-tokens";
import { LIST_RUNS_MAX } from "@/server/api";
import { MAX_CONNECTORS } from "@/server/connectors";
import { MCP_MISSIONS, MCP_REQUESTS_PER_HOUR } from "@/server/mcp-endpoint";
import { PLAN_TIMEOUT_MS } from "@/server/plan-approval";
import { GUEST_RUN_BUDGET } from "@/server/runs";
import {
  GUEST_RUNS_PER_HOUR,
  NETWORK_RUNS_PER_HOUR,
  SESSION_MAX_AGE_SECONDS,
} from "@/server/session";
import { SHIP_APPROVAL_TIMEOUT_MS } from "@/server/ship-approval";
import { TOOL_APPROVAL_TIMEOUT_MS } from "@/server/tool-approval";

import { LIVE_DEMO_ORIGIN } from "./links";
import { GUIDES_DIRECTORY } from "./manifest";
import { parseMarkdown, walkTokens } from "./markdown";
import { readRepoText } from "./repo";

const number = new Intl.NumberFormat("en-US");

function guide(name: string): string {
  return readRepoText(`${GUIDES_DIRECTORY}/${name}.md`);
}

function codeBlocks(markdown: string): { lang: string; text: string }[] {
  const blocks: { lang: string; text: string }[] = [];
  walkTokens(parseMarkdown(markdown).tokens, (token) => {
    if (token.type === "code")
      blocks.push({ lang: String(token.lang ?? ""), text: String(token.text) });
  });
  return blocks;
}

describe("MCP client guide", () => {
  const blocks = codeBlocks(guide("connect-mcp-clients"));

  it.each(clientSnippets(LIVE_DEMO_ORIGIN))(
    "shows the $client snippet exactly as the Connections page does",
    (snippet) => {
      expect(blocks).toContainEqual({ lang: snippet.language, text: snippet.code });
    },
  );

  it("names every mission the endpoint can start and the long-poll limits", () => {
    const text = guide("connect-mcp-clients");
    for (const mission of MCP_MISSIONS) expect(text).toContain(`\`${mission.id}\``);
    expect(text).toContain(
      `${WAIT_DEFAULT_SECONDS} seconds by default, ${WAIT_MAX_SECONDS} at most`,
    );
    expect(text).toContain(`at most ${MAX_ACTIVE_TOKENS} active tokens`);
    expect(text).toContain(`${number.format(MCP_REQUESTS_PER_HOUR)} MCP requests an hour`);
    expect(text).toContain(`${LIST_RUNS_MAX} at most`);
    expect(text).toContain(
      `${GUEST_RUNS_PER_HOUR} an hour per user and ${NETWORK_RUNS_PER_HOUR} an hour per network address`,
    );
  });

  it("says which missions the stdio server can start", () => {
    const ids = STDIO_MISSIONS.map((mission) => `\`${mission.id}\``);
    expect(guide("connect-mcp-clients")).toContain(
      `Its \`start_mission\` starts ${ids.slice(0, -1).join(", ")} and ${ids.at(-1) ?? ""} only.`,
    );
  });
});

describe("guides quote the limits the code enforces", () => {
  const minutes = (ms: number) => ms / 60_000;
  const seconds = (ms: number) => ms / 1000;

  it("quickstart", () => {
    const text = guide("quickstart");
    expect(text).toContain(`| Runs per guest | ${GUEST_RUNS_PER_HOUR} per hour |`);
    expect(text).toContain(`| Runs per network address | ${NETWORK_RUNS_PER_HOUR} per hour |`);
    expect(text).toContain(`| Tokens per run | ${number.format(GUEST_RUN_BUDGET.maxTokens)} |`);
    expect(GUEST_RUN_BUDGET.maxMicroUsd).toBe(0);
    expect(text).toContain(`lasts ${SESSION_MAX_AGE_SECONDS / 86_400} days`);
    expect(text).toContain(`within ${minutes(PLAN_TIMEOUT_MS)} minutes is rejected`);
    expect(text).toContain(
      `Input is cut at ${number.format(MAX_INPUT_LENGTH)} characters, and a goal at ${GOAL_MAX_CHARS}`,
    );
    expect(text).toContain(`${seconds(XRAY_LIMITS.targetMs)} seconds for a Company X-ray`);
  });

  it("missions", () => {
    const text = guide("missions");
    expect(text).toContain(
      `At most ${XRAY_LIMITS.crawlBudgetPages} pages crawled in ${seconds(XRAY_LIMITS.crawlBudgetMs)} seconds, of which the quarantined reader reads ${XRAY_LIMITS.crawlPages}`,
    );
    expect(XRAY_LIMITS.deepRounds).toBe(2);
    expect(text).toContain(`The time target is ${seconds(XRAY_LIMITS.targetMs)} seconds`);
    expect(text).toContain(
      `at most ${DIFF_LIMITS.maxFiles} files and ${DIFF_LIMITS.maxPatchBytes / 1000} KB`,
    );
    expect(text).toContain(
      `within ${minutes(SHIP_APPROVAL_TIMEOUT_MS)} minutes counts as a rejection`,
    );
    expect(text).toContain(`A \`goal\` of 3 to ${GOAL_MAX_CHARS} characters`);
    expect(text).toContain(`a plan of ${GOAL_STEP_LIMITS.min} to ${GOAL_STEP_LIMITS.max} steps`);
    expect(text).toContain(
      `At most ${GOAL_LIMITS.crawlBudgetPages} pages crawled in ${seconds(GOAL_LIMITS.crawlBudgetMs)} seconds, ${GOAL_LIMITS.crawlPages} read`,
    );
    expect(GOAL_LIMITS.deepRounds).toBe(2);
    expect(GOAL_LIMITS.connectorToolCalls).toBe(6);
    expect(text).toContain(`a hard deadline of ${seconds(GOAL_LIMITS.hardDeadlineMs)} seconds`);
    expect(text).toContain(
      `At most ${AUTOPILOT_LIMITS.maxChildren} child runs, one level deep, within ${minutes(AUTOPILOT_LIMITS.maxWallMs)} minutes and ${AUTOPILOT_LIMITS.maxTokens / 1_000_000} million tokens`,
    );
    expect(AUTOPILOT_LIMITS.maxDepth).toBe(1);
    expect(text).toContain(`at most ${number.format(GUEST_RUN_BUDGET.maxTokens)} tokens`);
  });

  it("connectors", () => {
    const text = guide("connect-mcp-servers");
    expect(text).toContain(`at most ${MAX_CONNECTORS} connectors`);
    expect(text).toContain(`within ${minutes(TOOL_APPROVAL_TIMEOUT_MS)} minutes`);
    expect(text).toContain("at most six tool calls");
    expect(GOAL_LIMITS.connectorToolCalls).toBe(6);
  });

  it("run page and approvals", () => {
    expect(guide("reading-a-run")).toContain(
      `at ${REPLAY_SPEEDS.map((speed) => `${speed}×`)
        .join(", ")
        .replace(/, ([^,]+)$/, " or $1")}`,
    );
    expect(guide("reading-a-run")).toContain(
      `up to ${number.format(MAX_FORK_OBJECTIVE_CHARS)} characters`,
    );
    const approvals = guide("policy-and-approvals");
    expect(minutes(PLAN_TIMEOUT_MS)).toBe(10);
    expect(minutes(TOOL_APPROVAL_TIMEOUT_MS)).toBe(10);
    expect(minutes(SHIP_APPROVAL_TIMEOUT_MS)).toBe(10);
    expect(approvals.match(/after 10 minutes/g)).toHaveLength(4);
  });
});
