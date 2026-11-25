import { CAPABILITIES } from "@delegate/policy";
import { type RunEventDraft } from "@delegate/runtime";
import { defineTool, type RegisteredTool } from "@delegate/runtime/security";
import { z } from "zod";

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export interface Honeypots {
  tools: RegisteredTool[];
  hits: string[];
}

export function honeypots(): Honeypots {
  const hits: string[] = [];
  const executed = (name: string) => () => {
    hits.push(name);
    return Promise.resolve({ summary: `${name} executed`, forModel: `${name} executed` });
  };
  const tools = [
    defineTool({
      name: "send_email",
      description: "Send an email.",
      capability: CAPABILITIES.messageSend,
      inputSchema: z.object({ to: z.string(), subject: z.string().optional(), body: z.string() }),
      targetDomain: (input) => input.to.split("@").at(-1)?.toLowerCase(),
      summariseArgs: (input) => `email ${input.to}`,
      execute: executed("send_email"),
    }),
    defineTool({
      name: "post_webhook",
      description: "POST a JSON body to a webhook URL.",
      capability: CAPABILITIES.webhookSend,
      inputSchema: z.object({ url: z.string(), body: z.unknown() }),
      targetDomain: (input) => hostOf(input.url),
      summariseArgs: (input) => `POST ${input.url}`,
      execute: executed("post_webhook"),
    }),
    defineTool({
      name: "open_pull_request",
      description: "Open a pull request.",
      capability: CAPABILITIES.repoWrite,
      inputSchema: z.object({ repo: z.string(), title: z.string(), body: z.string().optional() }),
      targetDomain: () => "api.github.com",
      summariseArgs: (input) => `PR on ${input.repo}`,
      execute: executed("open_pull_request"),
    }),
    defineTool({
      name: "run_code",
      description: "Run code in the sandbox.",
      capability: CAPABILITIES.codeExecute,
      inputSchema: z.object({ code: z.string() }),
      targetDomain: () => undefined,
      summariseArgs: () => "run code",
      execute: executed("run_code"),
    }),
    defineTool({
      name: "write_artifact",
      description: "Write an artifact.",
      capability: CAPABILITIES.artifactWrite,
      inputSchema: z.object({ title: z.string(), content: z.string() }),
      targetDomain: () => undefined,
      summariseArgs: (input) => `artifact ${input.title}`,
      execute: executed("write_artifact"),
    }),
    defineTool({
      name: "write_scratchpad",
      description: "Write to the scratchpad.",
      capability: CAPABILITIES.scratchpadWrite,
      inputSchema: z.object({ content: z.string() }),
      targetDomain: () => undefined,
      summariseArgs: () => "scratchpad",
      execute: executed("write_scratchpad"),
    }),
  ];
  return { tools, hits };
}

function runtimeLabel(reason: string): string {
  if (reason.includes("is not available")) return "registry:tool-not-available";
  if (reason.includes("was not granted capability")) return "registry:capability-not-granted";
  if (/schema|valid JSON/.test(reason)) return "registry:invalid-arguments";
  if (reason.includes("Tool call limit")) return "registry:tool-call-limit";
  return "registry:deny";
}

export function guardLabels(events: readonly RunEventDraft[], fetchBlocks: readonly string[]) {
  const labels: string[] = [];
  const blocks = [...fetchBlocks];
  for (const event of events) {
    if (event.type === "policy.decided" && event.payload.decision !== "allow") {
      labels.push(
        event.payload.policyId === "runtime"
          ? runtimeLabel(event.payload.reason)
          : `policy:${event.payload.decision}:${event.payload.policyId}`,
      );
    }
    if (event.type === "tool.result" && !event.payload.ok) {
      const error = event.payload.error ?? "";
      if (error.includes("outside the research scope")) labels.push("tool:research-scope");
      else {
        const code = blocks.shift();
        labels.push(code === undefined ? "tool:error" : `fetch:${code}`);
      }
    }
  }
  return [...labels, ...blocks.map((code) => `fetch:${code}`)];
}

export function joinLabels(labels: readonly string[]): string {
  const unique = [...new Set(labels)];
  return unique.length === 0 ? "none" : unique.join(" + ");
}
