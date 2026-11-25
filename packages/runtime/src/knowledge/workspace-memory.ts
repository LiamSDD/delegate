import { z } from "zod";

import { detectInjection } from "../quarantine/reader";
import { type MemoryEntry, type MemoryStore } from "./types";

export const MEMORY_KEYS = {
  company: "company",
  agents: "agents",
  last: (missionId: string) => `last.${missionId}`,
} as const;

const MAX_AGENTS = 10;

export function sanitiseName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N} .&'’-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  if (name === "" || detectInjection(name) !== undefined) return undefined;
  return name;
}

const CompanySchema = z.object({ name: z.string(), url: z.string() });
const LastRunSchema = z.object({ runId: z.string(), at: z.string() }).loose();
const AgentSchema = z.object({
  assistantId: z.string(),
  name: z.string(),
  runId: z.string(),
  passRate: z.number().nullable(),
});
const AgentsSchema = z.array(AgentSchema);

export interface RunMemoryInput {
  runId: string;
  missionId: string;
  input: unknown;
  at: string;
  artifacts: readonly { kind: string; content: unknown }[];
}

function urlOf(input: unknown): string | undefined {
  const parsed = z.object({ url: z.url() }).safeParse(input);
  return parsed.success ? parsed.data.url : undefined;
}

function lastOfKind(artifacts: RunMemoryInput["artifacts"], kind: string): unknown {
  return [...artifacts].reverse().find((artifact) => artifact.kind === kind)?.content;
}

export async function recordRunMemory(memory: MemoryStore, run: RunMemoryInput): Promise<void> {
  const url = urlOf(run.input);
  const audit = z
    .object({ company: z.string(), opportunities: z.array(z.unknown()) })
    .safeParse(lastOfKind(run.artifacts, "automation-audit"));
  const brief = z
    .object({ company: z.object({ name: z.string() }) })
    .safeParse(lastOfKind(run.artifacts, "company-xray-brief"));
  const assistant = z
    .object({ id: z.string(), name: z.string(), passRate: z.number().nullable().optional() })
    .safeParse(lastOfKind(run.artifacts, "assistant"));
  const company = sanitiseName(
    audit.success ? audit.data.company : brief.success ? brief.data.company.name : undefined,
  );
  if (company !== undefined && url !== undefined)
    await memory.write({ key: MEMORY_KEYS.company, value: { name: company, url } });
  await memory.write({
    key: MEMORY_KEYS.last(run.missionId),
    value: {
      runId: run.runId,
      at: run.at,
      ...(url === undefined ? {} : { url }),
      ...(audit.success ? { opportunities: audit.data.opportunities.length } : {}),
    },
  });
  if (assistant.success) {
    const existing = AgentsSchema.safeParse(
      (await memory.read()).find((entry) => entry.key === MEMORY_KEYS.agents)?.value,
    );
    const agents = (existing.success ? existing.data : []).filter(
      (agent) => agent.assistantId !== assistant.data.id,
    );
    const name = sanitiseName(assistant.data.name) ?? "Assistant";
    await memory.write({
      key: MEMORY_KEYS.agents,
      value: [
        {
          assistantId: assistant.data.id,
          name,
          runId: run.runId,
          passRate: assistant.data.passRate ?? null,
        },
        ...agents,
      ].slice(0, MAX_AGENTS),
    });
  }
}

export function memoryNotes(entries: readonly MemoryEntry[]): string[] {
  const notes: string[] = [];
  for (const entry of entries) {
    if (entry.key === MEMORY_KEYS.company) {
      const company = CompanySchema.safeParse(entry.value);
      const name = company.success ? sanitiseName(company.data.name) : undefined;
      if (company.success && name !== undefined)
        notes.push(`- Company: ${name} (${company.data.url})`);
    } else if (entry.key === MEMORY_KEYS.agents) {
      const agents = AgentsSchema.safeParse(entry.value);
      if (agents.success && agents.data.length > 0)
        notes.push(
          `- Assistants already built: ${agents.data
            .map(
              (agent) =>
                `${sanitiseName(agent.name) ?? "Assistant"} (pass rate ${agent.passRate === null ? "n/a" : `${Math.round(agent.passRate * 100)}%`})`,
            )
            .join(", ")}`,
        );
    } else if (entry.key.startsWith("last.")) {
      const last = LastRunSchema.safeParse(entry.value);
      if (last.success)
        notes.push(`- Last ${entry.key.slice(5)} run: ${last.data.runId} at ${last.data.at}`);
    }
  }
  return notes;
}
