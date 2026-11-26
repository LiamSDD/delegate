import { z } from "zod";

import {
  CriticReportSchema,
  ResearchReportSchema,
  type AgentRole,
  type ModelRole,
  type PlanStep,
} from "../events";
import { SourceRecordSchema } from "../tools/sources";
import { type StepGrant } from "../tools/registry";
import { type Blackboard } from "./blackboard";
import { type TeamHandle, type TeamSupport } from "./team";

export const FindingSchema = z.object({
  text: z.string().trim().min(1).max(600),
  citations: z.array(z.string().min(1)).max(8),
  quote: z.string().max(400).optional(),
  topic: z.string().max(40).optional(),
  trust: z.enum(["untrusted", "derived"]),
});
export type Finding = z.infer<typeof FindingSchema>;

export const SubAgentResultSchema = z.object({
  summary: z.string().max(1000),
  findings: z.array(FindingSchema).max(500),
  sources: z.array(SourceRecordSchema).max(200),
  confidence: z.number().min(0).max(1),
  artifacts: z.array(z.string().min(1)).max(50),
  needsReplan: z.object({ reason: z.string().min(1).max(500) }).optional(),
  critic: CriticReportSchema.optional(),
  research: ResearchReportSchema.optional(),
});
export type SubAgentResult = z.infer<typeof SubAgentResultSchema>;

export interface AgentHandle {
  agentId: string;
  say: (text: string) => Promise<void>;
}

export interface SubAgentTask {
  step: PlanStep;
  grant: StepGrant;
  agent: AgentHandle;
  inputs: ReadonlyMap<string, SubAgentResult>;
  spawn: (role: AgentRole, modelRole: ModelRole) => Promise<AgentHandle>;
  blackboard: () => Blackboard;
  guidance?: readonly string[];
  team?: TeamHandle;
  unmetAcceptance?: readonly string[];
}

export interface StepExecutor {
  id: string;
  role: AgentRole;
  modelRole: ModelRole;
  capabilities: readonly string[];
  description: string;
  needs?: readonly string[];
  required?: boolean;
  repeatable?: boolean;
  team?: TeamSupport;
  selfCheck?: boolean;
  run: (task: SubAgentTask) => Promise<SubAgentResult>;
}

export class FatalStepError extends Error {
  override readonly name = "FatalStepError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function inputFindings(task: Pick<SubAgentTask, "inputs">): Finding[] {
  return [...task.inputs.values()].flatMap((result) => result.findings);
}

export function inputSources(task: Pick<SubAgentTask, "inputs">) {
  const seen = new Map<string, z.infer<typeof SourceRecordSchema>>();
  for (const result of task.inputs.values())
    for (const source of result.sources) seen.set(source.sourceId, source);
  return [...seen.values()];
}

export function inputArtifacts(task: Pick<SubAgentTask, "inputs">): string[] {
  return [...task.inputs.values()].flatMap((result) => result.artifacts);
}
