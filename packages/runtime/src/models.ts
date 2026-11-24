import { z } from "zod";

import { type ModelRole } from "./events";

export const PROVIDER_KINDS = ["openai-compatible", "anthropic", "webllm", "ollama"] as const;
export const PROVIDER_TERMS = ["public-demo-ok", "evaluation-only", "local-only", "byok"] as const;
export const DATA_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export const DataClassificationSchema = z.enum(DATA_CLASSIFICATIONS);
export type DataClassification = z.infer<typeof DataClassificationSchema>;
export const DEFAULT_CLASSIFICATION: DataClassification = "internal";
export const PUBLIC_DEMO_TERMS: readonly (typeof PROVIDER_TERMS)[number][] = [
  "public-demo-ok",
  "local-only",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const ModelPriceSchema = z.strictObject({
  inputUsdPerMTok: z.number().nonnegative(),
  outputUsdPerMTok: z.number().nonnegative(),
  cacheReadUsdPerMTok: z.number().nonnegative(),
  cacheWriteUsdPerMTok: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const ProviderConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: z.string().min(1).optional(),
  chatPath: z.string().startsWith("/").optional(),
  apiKeyEnv: envName.optional(),
  requiredEnv: z.array(envName).optional(),
  keyless: z.boolean(),
  terms: z.enum(PROVIDER_TERMS),
  maxClassification: DataClassificationSchema,
  dataPolicy: z.string().min(1),
  limits: z
    .strictObject({
      requestsPerMinute: z.number().positive().optional(),
      tokensPerMinute: z.number().positive().optional(),
    })
    .optional(),
  pricing: z.record(z.string(), ModelPriceSchema).optional(),
  unverified: z.boolean().optional(),
  notes: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const RoleEntrySchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  contextWindow: z.number().int().positive(),
  supportsTools: z.boolean(),
  quirks: z.array(z.string().min(1)).optional(),
  unverified: z.boolean().optional(),
});
export type RoleEntry = z.infer<typeof RoleEntrySchema>;

export const ModelsConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    version: z.literal(1),
    providers: z.array(ProviderConfigSchema),
    roles: z.strictObject({
      planner: z.array(RoleEntrySchema),
      worker: z.array(RoleEntrySchema),
      fast: z.array(RoleEntrySchema),
    }),
  })
  .superRefine((config, ctx) => {
    const providers = new Map<string, ProviderConfig>();
    for (const provider of config.providers) {
      if (providers.has(provider.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate provider id ${provider.id}` });
      }
      providers.set(provider.id, provider);
      if (!provider.keyless && provider.apiKeyEnv === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `Provider ${provider.id} needs apiKeyEnv or keyless: true`,
        });
      }
      if (
        (provider.kind === "openai-compatible" || provider.kind === "ollama") &&
        provider.baseUrl === undefined
      ) {
        ctx.addIssue({ code: "custom", message: `Provider ${provider.id} needs a baseUrl` });
      }
      if (provider.baseUrl !== undefined) {
        const problem = baseUrlProblem(
          provider,
          provider.baseUrl.replace(/\$\{[A-Z][A-Z0-9_]*\}/g, "placeholder"),
        );
        if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
      }
    }
    for (const role of ["planner", "worker", "fast"] as const) {
      for (const entry of config.roles[role]) {
        const provider = providers.get(entry.provider);
        if (provider === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `Role ${role} references unknown provider ${entry.provider}`,
          });
          continue;
        }
        if (provider.terms === "byok" && provider.pricing?.[entry.model] === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `BYOK model ${provider.id}/${entry.model} in role ${role} needs pricing`,
          });
        }
      }
    }
  });
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export function parseModelsConfig(input: unknown): ModelsConfig {
  return ModelsConfigSchema.parse(input);
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface ChainContext {
  config: ModelsConfig;
  audience: "public-demo" | "owner";
  environment: "server" | "browser";
  classification: DataClassification;
  byokKeys?: Readonly<Record<string, string | undefined>>;
  localOptIn?: boolean;
}

export interface ChainEntry {
  role: ModelRole;
  provider: ProviderConfig;
  model: string;
  contextWindow: number;
  supportsTools: boolean;
  quirks: string[];
  unverified: boolean;
}

function hasEnv(env: Env, name: string | undefined): boolean {
  if (name === undefined) return false;
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

function companionsPresent(provider: ProviderConfig, env: Env): boolean {
  return (provider.requiredEnv ?? []).every((name) => hasEnv(env, name));
}

function classificationRank(classification: DataClassification | undefined): number {
  return DATA_CLASSIFICATIONS.indexOf(classification ?? DEFAULT_CLASSIFICATION);
}

export function allowsClassification(
  provider: ProviderConfig,
  classification: DataClassification | undefined,
): boolean {
  return classificationRank(classification) <= classificationRank(provider.maxClassification);
}

function visitorKeySupplied(provider: ProviderConfig, context: Omit<ChainContext, "config">) {
  const key = context.byokKeys?.[provider.id];
  return key !== undefined && key.trim() !== "";
}

export function isProviderAvailable(
  provider: ProviderConfig,
  env: Env,
  context: Omit<ChainContext, "config">,
): boolean {
  if (!allowsClassification(provider, context.classification)) return false;
  if (context.audience === "public-demo") {
    const allowed =
      PUBLIC_DEMO_TERMS.includes(provider.terms) ||
      (provider.terms === "byok" && visitorKeySupplied(provider, context));
    if (!allowed) return false;
  }
  if (provider.kind === "webllm") return context.environment === "browser";
  if (provider.kind === "ollama")
    return context.environment === "server" && context.localOptIn === true;
  if (provider.terms === "byok") {
    if (visitorKeySupplied(provider, context)) return true;
    return (
      context.audience !== "public-demo" &&
      hasEnv(env, provider.apiKeyEnv) &&
      companionsPresent(provider, env)
    );
  }
  if (!companionsPresent(provider, env)) return false;
  return provider.keyless || hasEnv(env, provider.apiKeyEnv);
}

export function resolveChain(role: ModelRole, env: Env, context: ChainContext): ChainEntry[] {
  const providers = new Map(context.config.providers.map((provider) => [provider.id, provider]));
  const chain: ChainEntry[] = [];
  for (const entry of context.config.roles[role]) {
    const provider = providers.get(entry.provider);
    if (provider === undefined || !isProviderAvailable(provider, env, context)) continue;
    chain.push({
      role,
      provider,
      model: entry.model,
      contextWindow: entry.contextWindow,
      supportsTools: entry.supportsTools,
      quirks: entry.quirks ?? [],
      unverified: entry.unverified === true || provider.unverified === true,
    });
  }
  return chain;
}

function baseUrlProblem(provider: ProviderConfig, url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Provider ${provider.id} baseUrl is not a valid URL`;
  }
  if (parsed.protocol === "https:") return undefined;
  const localHttp =
    parsed.protocol === "http:" &&
    (provider.kind === "ollama" ||
      (provider.terms === "local-only" && LOOPBACK_HOSTS.has(parsed.hostname)));
  if (localHttp) return undefined;
  return `Provider ${provider.id} baseUrl must use https (http is allowed only for local providers on loopback)`;
}

export function resolveBaseUrl(provider: ProviderConfig, env: Env): string | undefined {
  if (provider.baseUrl === undefined) return undefined;
  const resolved = provider.baseUrl.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(`Provider ${provider.id} baseUrl needs env ${name}`);
    }
    return encodeURIComponent(value);
  });
  const problem = baseUrlProblem(provider, resolved);
  if (problem !== undefined) throw new Error(problem);
  return resolved;
}
