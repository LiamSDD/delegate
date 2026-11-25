import {
  type ChainEntry,
  type ModelRole,
  type ModelsConfig,
  parseModelsConfig,
  type ProviderConfig,
  resolveChain,
} from "@delegate/runtime";

const ROLES: readonly ModelRole[] = ["planner", "worker", "fast"];

export type ProviderPlacement = "hosted" | "in-browser";

export interface KeylessProvider {
  id: string;
  name: string;
  placement: ProviderPlacement;
  models: string[];
  roles: ModelRole[];
}

export type ChainSummary =
  { status: "ok"; providers: KeylessProvider[] } | { status: "unavailable"; reason: string };

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  pollinations: "Pollinations",
  llm7: "LLM7",
  webllm: "WebLLM",
};

const NO_ENV = {} as const;

function displayName(id: string): string {
  return DISPLAY_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function placementOf(kind: ProviderConfig["kind"]): ProviderPlacement | null {
  if (kind === "openai-compatible") return "hosted";
  if (kind === "webllm") return "in-browser";
  return null;
}

function parse(input: unknown): ModelsConfig | null {
  try {
    return parseModelsConfig(input);
  } catch {
    return null;
  }
}

function publicVisitorChain(config: ModelsConfig, role: ModelRole): ChainEntry[] {
  return resolveChain(role, NO_ENV, {
    config,
    audience: "public-demo",
    environment: "browser",
    classification: "public",
  });
}

export function summariseKeylessChain(input: unknown): ChainSummary {
  const config = parse(input);
  if (config === null) {
    return {
      status: "unavailable",
      reason: "config/models.json did not match the expected schema",
    };
  }
  const summary = new Map<string, KeylessProvider>();

  for (const role of ROLES) {
    for (const entry of publicVisitorChain(config, role)) {
      const { provider } = entry;
      if (!provider.keyless) continue;
      const placement = placementOf(provider.kind);
      if (placement === null) continue;
      const existing = summary.get(provider.id) ?? {
        id: provider.id,
        name: displayName(provider.id),
        placement,
        models: [],
        roles: [],
      };
      if (!existing.models.includes(entry.model)) existing.models.push(entry.model);
      if (!existing.roles.includes(role)) existing.roles.push(role);
      summary.set(provider.id, existing);
    }
  }

  if (summary.size === 0)
    return { status: "unavailable", reason: "No keyless provider is configured" };
  return { status: "ok", providers: [...summary.values()] };
}
