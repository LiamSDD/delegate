import { z } from "zod";

const ROLES = ["planner", "worker", "fast"] as const;
export type ModelRole = (typeof ROLES)[number];

const ProviderSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["openai-compatible", "anthropic", "webllm", "ollama"]),
  keyless: z.boolean(),
  terms: z.enum(["public-demo-ok", "evaluation-only", "local-only", "byok"]),
});

const EntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const ConfigSchema = z.object({
  version: z.literal(1),
  providers: z.array(ProviderSchema),
  roles: z.object({
    planner: z.array(EntrySchema),
    worker: z.array(EntrySchema),
    fast: z.array(EntrySchema),
  }),
});

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

function displayName(id: string): string {
  return DISPLAY_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function placementOf(kind: z.infer<typeof ProviderSchema>["kind"]): ProviderPlacement | null {
  if (kind === "openai-compatible") return "hosted";
  if (kind === "webllm") return "in-browser";
  return null;
}

export function summariseKeylessChain(input: unknown): ChainSummary {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "unavailable",
      reason: "config/models.json did not match the expected schema",
    };
  }
  const providers = new Map(parsed.data.providers.map((provider) => [provider.id, provider]));
  const summary = new Map<string, KeylessProvider>();

  for (const role of ROLES) {
    for (const entry of parsed.data.roles[role]) {
      const provider = providers.get(entry.provider);
      if (provider === undefined || !provider.keyless || provider.terms !== "public-demo-ok")
        continue;
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
