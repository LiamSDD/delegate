import modelsConfig from "@config/models.json";
import {
  CAPABILITIES,
  type Capability,
  CONNECTOR_CAPABILITIES,
  type Decision,
  defaultPolicy,
  evaluate,
  evaluateAll,
  GITHUB_API_HOST,
  GITHUB_OPEN_PR_TOOL,
  ownerDefaultPolicy,
  type Policy,
  type PolicyContext,
  type ProviderTerms,
  shipConnectedPolicy,
  shipDemoPolicy,
  shipOwnerPolicy,
  SIDE_EFFECT_CAPABILITIES,
  withConnectorAccess,
} from "@delegate/policy";
import {
  autopilotChildPolicy,
  type AutopilotTier,
  MISSIONS,
  type ModelsConfig,
  parseModelsConfig,
  resolveChain,
} from "@delegate/runtime";
import { connectorToolName } from "@delegate/runtime/server";
import { z } from "zod";

import { isOwnerModeEnabled } from "@/flags";
import { RUNNABLE_MISSION_IDS, SHIP_MISSION_ID } from "@/lib/m2-contract";

import { type ApiDeps, apiError, guestFor, NO_STORE, readJson } from "../api";
import { listConnectors } from "../connectors";
import type { AppDatabase } from "../db";
import type { GuestSession } from "../session";
import { guardWebMutation, issuesOf } from "./http";
import { workspaceOverview } from "./workspace";

export const SIMULATED_MISSION_IDS = [...RUNNABLE_MISSION_IDS, SHIP_MISSION_ID] as const;
export type SimulatedMissionId = (typeof SIMULATED_MISSION_IDS)[number];

export const RUN_ORIGINS = ["direct", "autopilot"] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

export const CAPABILITY_IDS = Object.values(CAPABILITIES) as [Capability, ...Capability[]];

const CONNECTOR_TOOL = /^mcp__[a-z0-9][a-z0-9-]{0,31}__[A-Za-z0-9_-]{1,64}$/;

export interface ConnectorToolFact {
  name: string;
  readOnly: boolean;
  host: string;
}

export interface PolicyFacts {
  audience: "public-demo" | "owner";
  tier: AutopilotTier;
  connectorHosts: string[];
  connectorTools: ConnectorToolFact[];
}

export const NO_WORKSPACE_FACTS: Omit<PolicyFacts, "audience"> = {
  tier: "guest",
  connectorHosts: [],
  connectorTools: [],
};

export async function policyFacts(
  app: AppDatabase,
  session: GuestSession | null,
  env: Record<string, string | undefined>,
): Promise<PolicyFacts> {
  const audience = isOwnerModeEnabled(env) ? "owner" : "public-demo";
  if (session === null) return { audience, ...NO_WORKSPACE_FACTS };
  const [overview, connectors] = await Promise.all([
    workspaceOverview(app, session),
    listConnectors(app, session),
  ]);
  return {
    audience,
    tier: overview?.tier ?? "guest",
    connectorHosts: [...new Set(connectors.map((connector) => connector.host))],
    connectorTools: connectors.flatMap((connector) =>
      connector.tools
        .filter((tool) => !tool.withheld)
        .map((tool) => ({
          name: connectorToolName(connector.name, tool.name),
          readOnly: tool.readOnly,
          host: connector.host,
        })),
    ),
  };
}

function basePolicy(
  missionId: SimulatedMissionId,
  audience: PolicyFacts["audience"],
  connected: boolean,
): Policy {
  if (missionId === SHIP_MISSION_ID)
    return audience === "owner"
      ? shipOwnerPolicy
      : connected
        ? shipConnectedPolicy
        : shipDemoPolicy;
  return audience === "public-demo" ? defaultPolicy : ownerDefaultPolicy;
}

export function policiesForRun(
  facts: PolicyFacts,
  missionId: SimulatedMissionId,
  origin: RunOrigin,
): Policy[] {
  const hasConnectors = facts.connectorHosts.length > 0;
  const child = autopilotChildPolicy(facts.tier, missionId, false);
  const connectors =
    origin === "direct"
      ? missionId !== SHIP_MISSION_ID && hasConnectors
      : child.connectors && hasConnectors;
  const installationLookup = origin === "direct" ? true : child.githubInstallation;
  return [
    withConnectorAccess(
      basePolicy(missionId, facts.audience, installationLookup),
      connectors ? facts.connectorHosts : [],
    ),
  ];
}

export interface PolicyUse {
  missionId: SimulatedMissionId;
  origin: RunOrigin;
}

export interface AppliedPolicy {
  policy: Policy;
  uses: PolicyUse[];
}

export function appliedPolicies(facts: PolicyFacts): AppliedPolicy[] {
  const applied = new Map<string, AppliedPolicy>();
  for (const origin of RUN_ORIGINS)
    for (const missionId of SIMULATED_MISSION_IDS)
      for (const policy of policiesForRun(facts, missionId, origin)) {
        const known = applied.get(policy.id) ?? { policy, uses: [] };
        known.uses.push({ missionId, origin });
        applied.set(policy.id, known);
      }
  return [...applied.values()];
}

export const SimulateRequestSchema = z
  .strictObject({
    missionId: z.enum(SIMULATED_MISSION_IDS),
    origin: z.enum(RUN_ORIGINS).default("direct"),
    capability: z.enum(CAPABILITY_IDS).optional(),
    tool: z
      .string()
      .trim()
      .min(1)
      .max(140)
      .regex(/^[A-Za-z0-9_.:-]+$/, {
        error: "Use letters, digits, dots, dashes, colons or underscores",
      })
      .optional(),
    host: z.string().trim().max(2048).optional(),
    sideEffect: z.boolean(),
  })
  .refine((request) => request.capability !== undefined || request.tool !== undefined, {
    path: ["capability"],
    error: "Choose a capability or name a tool",
  });
export type SimulateRequest = z.infer<typeof SimulateRequestSchema>;

export class SimulationInputError extends Error {
  override readonly name = "SimulationInputError";
}

export function hostOf(raw: string | undefined): string | undefined {
  const value = raw?.trim() ?? "";
  if (value === "") return undefined;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname;
  } catch {
    throw new SimulationInputError(`"${value.slice(0, 80)}" is not a host name or URL.`);
  }
  if (host === "") throw new SimulationInputError("The target host is empty.");
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

interface ResolvedCall {
  tool: string;
  capability: Capability;
  host: string | undefined;
  caller: "agent" | "system";
  notes: string[];
}

function isSideEffect(capability: Capability): boolean {
  return SIDE_EFFECT_CAPABILITIES.includes(capability);
}

export function resolveCall(request: SimulateRequest, facts: PolicyFacts): ResolvedCall {
  const notes: string[] = [];
  const typedHost = hostOf(request.host);
  let tool: string;
  let capability: Capability;
  let caller: ResolvedCall["caller"] = "agent";
  let host = typedHost;

  if (
    request.tool === GITHUB_OPEN_PR_TOOL ||
    (request.tool === undefined && request.capability === CAPABILITIES.repoWrite)
  ) {
    tool = GITHUB_OPEN_PR_TOOL;
    capability = CAPABILITIES.repoWrite;
    caller = "system";
    if (request.tool === undefined)
      notes.push(
        `${GITHUB_OPEN_PR_TOOL} is the only tool that holds ${capability}, so it is the tool checked.`,
      );
    if (host === undefined) {
      host = GITHUB_API_HOST;
      notes.push(`No host given: ${GITHUB_OPEN_PR_TOOL} always calls ${GITHUB_API_HOST}.`);
    }
    notes.push(
      "The pull request is opened by the runtime after the Engineer finishes, so no model provider is involved.",
    );
  } else if (request.tool !== undefined && CONNECTOR_TOOL.test(request.tool)) {
    tool = request.tool;
    const known = facts.connectorTools.find((entry) => entry.name === tool);
    if (known !== undefined) {
      capability = known.readOnly ? CAPABILITIES.connectorRead : CAPABILITIES.connectorWrite;
      notes.push(
        `${tool} is connected to this workspace and marked ${known.readOnly ? "read-only" : "as having side effects"} by its server.`,
      );
      if (host === undefined) {
        host = known.host;
        notes.push(`No host given: this connector calls ${known.host}.`);
      }
    } else {
      capability =
        request.capability !== undefined && CONNECTOR_CAPABILITIES.includes(request.capability)
          ? request.capability
          : request.sideEffect
            ? CAPABILITIES.connectorWrite
            : CAPABILITIES.connectorRead;
      notes.push(
        `${tool} is not a tool of a connector in this workspace, so it is checked as ${capability} from what you declared.`,
      );
    }
  } else if (request.capability !== undefined) {
    capability = request.capability;
    tool = request.tool ?? `any-${capability}-tool`;
    if (request.tool === undefined)
      notes.push(`No tool named: checked as any tool that holds ${capability}.`);
  } else {
    throw new SimulationInputError(
      `${request.tool ?? "That tool"} is not a built-in or connector tool Delegate can classify. Choose its capability as well.`,
    );
  }

  if (request.sideEffect !== isSideEffect(capability))
    notes.push(
      isSideEffect(capability)
        ? `${capability} always counts as a side effect: the capability decides, not the checkbox.`
        : `${capability} never counts as a side effect: the capability decides, not the checkbox.`,
    );
  return { tool, capability, host, caller, notes };
}

let parsedModels: ModelsConfig | undefined;

function servingProvider(
  audience: PolicyFacts["audience"],
  env: Record<string, string | undefined>,
): { id: string; terms: ProviderTerms } | undefined {
  parsedModels ??= parseModelsConfig(modelsConfig);
  const head = resolveChain("worker", env, {
    config: parsedModels,
    audience,
    environment: "server",
    classification: "public",
  })[0];
  return head === undefined ? undefined : { id: head.provider.id, terms: head.provider.terms };
}

export interface Simulation {
  decision: Decision;
  matched: Decision[];
  call: {
    missionId: SimulatedMissionId;
    origin: RunOrigin;
    tool: string;
    capability: Capability;
    host: string | null;
    sideEffect: boolean;
    caller: "agent" | "system";
    provider: { id: string; terms: ProviderTerms } | null;
    granted: boolean;
  };
  policies: { id: string; name: string }[];
  notes: string[];
}

export function simulate(
  request: SimulateRequest,
  facts: PolicyFacts,
  env: Record<string, string | undefined>,
): Simulation {
  const call = resolveCall(request, facts);
  const policies = policiesForRun(facts, request.missionId, request.origin);
  const provider = call.caller === "agent" ? servingProvider(facts.audience, env) : undefined;
  const granted: readonly string[] = MISSIONS[request.missionId].capabilities;
  const notes = [...call.notes];
  if (call.caller === "agent" && provider === undefined)
    notes.push(
      "No model provider is available to this deployment, so provider rules have nothing to check.",
    );
  const context: PolicyContext = {
    workspaceId: "dry-run",
    runId: "dry-run",
    stepId: "dry-run",
    actor: { type: call.caller, id: "dry-run" },
    tool: call.tool,
    capability: call.capability,
    grantedCapabilities: [...granted],
    argsSummary: "dry run",
    ...(call.host === undefined ? {} : { targetDomain: call.host }),
    dataClassification: "public",
    ...(provider === undefined ? {} : { provider }),
    estimatedCostMicroUsd: 0,
    spentRunMicroUsd: 0,
    spentDayMicroUsd: 0,
  };
  return {
    decision: evaluate(policies, context),
    matched: evaluateAll(policies, context),
    call: {
      missionId: request.missionId,
      origin: request.origin,
      tool: call.tool,
      capability: call.capability,
      host: call.host ?? null,
      sideEffect: isSideEffect(call.capability),
      caller: call.caller,
      provider: provider ?? null,
      granted: granted.includes(call.capability),
    },
    policies: policies.map((policy) => ({ id: policy.id, name: policy.name })),
    notes,
  };
}

export async function handleSimulatePolicy(
  request: Request,
  deps: ApiDeps,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const refused = guardWebMutation(request, "run the policy simulator");
  if (refused !== null) return refused;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const parsed = SimulateRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return apiError(400, "invalid_request", "The dry-run request is not valid.", {
      issues: issuesOf(parsed.error),
    });
  const guest = await guestFor(request, deps);
  const facts = await policyFacts(guest?.app ?? (await deps.app()), guest?.session ?? null, env);
  try {
    return Response.json(simulate(parsed.data, facts, env), { headers: NO_STORE });
  } catch (error: unknown) {
    if (error instanceof SimulationInputError)
      return apiError(400, "invalid_request", error.message);
    throw error;
  }
}
