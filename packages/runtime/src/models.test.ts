import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ModelsConfigSchema,
  ProviderConfigSchema,
  parseModelsConfig,
  resolveBaseUrl,
  resolveChain,
  type ChainContext,
  type ModelsConfig,
} from "./models";

const rootConfig: unknown = JSON.parse(
  readFileSync(new URL("../../../config/models.json", import.meta.url), "utf8"),
);

const fixture: ModelsConfig = parseModelsConfig({
  version: 1,
  providers: [
    {
      id: "keyless",
      kind: "openai-compatible",
      baseUrl: "https://keyless.test/v1",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "community",
    },
    {
      id: "browser",
      kind: "webllm",
      keyless: true,
      terms: "local-only",
      maxClassification: "confidential",
      dataPolicy: "on device",
    },
    {
      id: "local",
      kind: "ollama",
      baseUrl: "http://localhost:11434/v1",
      keyless: true,
      terms: "local-only",
      maxClassification: "restricted",
      dataPolicy: "on device",
    },
    {
      id: "trial",
      kind: "openai-compatible",
      baseUrl: "https://trial.test/v1",
      apiKeyEnv: "TRIAL_KEY",
      keyless: false,
      terms: "evaluation-only",
      maxClassification: "public",
      dataPolicy: "trial",
    },
    {
      id: "free",
      kind: "openai-compatible",
      baseUrl: "https://free.test/accounts/${FREE_ACCOUNT}/v1",
      apiKeyEnv: "FREE_KEY",
      requiredEnv: ["FREE_ACCOUNT"],
      keyless: false,
      terms: "public-demo-ok",
      maxClassification: "internal",
      dataPolicy: "no training",
    },
    {
      id: "claude",
      kind: "anthropic",
      apiKeyEnv: "CLAUDE_KEY",
      keyless: false,
      terms: "byok",
      maxClassification: "confidential",
      dataPolicy: "byok",
      pricing: {
        big: {
          inputUsdPerMTok: 4,
          outputUsdPerMTok: 20,
          cacheReadUsdPerMTok: 0.2,
          cacheWriteUsdPerMTok: 5,
        },
      },
    },
  ],
  roles: {
    planner: [
      { provider: "keyless", model: "k-1", contextWindow: 32000, supportsTools: true },
      { provider: "browser", model: "b-1", contextWindow: 4096, supportsTools: true },
      { provider: "local", model: "l-1", contextWindow: 32768, supportsTools: true },
      {
        provider: "trial",
        model: "t-1",
        contextWindow: 256000,
        supportsTools: true,
        quirks: ["echo-reasoning-content"],
      },
      { provider: "free", model: "f-1", contextWindow: 131072, supportsTools: true },
      { provider: "claude", model: "big", contextWindow: 200000, supportsTools: true },
    ],
    worker: [
      {
        provider: "trial",
        model: "t-slow",
        contextWindow: 256000,
        supportsTools: true,
        interactive: false,
      },
      { provider: "trial", model: "t-2", contextWindow: 128000, supportsTools: true },
      { provider: "keyless", model: "k-2", contextWindow: 32000, supportsTools: true },
    ],
    fast: [{ provider: "browser", model: "b-2", contextWindow: 4096, supportsTools: false }],
  },
});

const server: Omit<ChainContext, "config"> = {
  audience: "owner",
  environment: "server",
  classification: "public",
};

function chainIds(env: Record<string, string | undefined>, context: Omit<ChainContext, "config">) {
  return resolveChain("planner", env, { config: fixture, ...context }).map(
    (entry) => entry.provider.id,
  );
}

describe("config/models.json", () => {
  it("matches the schema", () => {
    expect(() => ModelsConfigSchema.parse(rootConfig)).not.toThrow();
  });

  it("orders every role as ADR 0003 Amendment 3: ranked keyed free-tier entries first, then keyless, browser, local, optional keys and BYOK last", () => {
    const config = parseModelsConfig(rootConfig);
    const providerOf = (providerId: string) => {
      const provider = config.providers.find((candidate) => candidate.id === providerId);
      if (provider === undefined) throw new Error(providerId);
      return provider;
    };
    const rank = (providerId: string): number => {
      const provider = providerOf(providerId);
      if (provider.kind === "webllm") return 1;
      if (provider.kind === "ollama") return 2;
      if (provider.terms === "byok") return 4;
      return provider.keyless ? 0 : 3;
    };
    for (const role of ["planner", "worker", "fast"] as const) {
      const entries = config.roles[role];
      const firstKeyless = entries.findIndex((entry) => providerOf(entry.provider).keyless);
      const leading = entries.slice(0, firstKeyless);
      expect(
        leading.every((entry) => {
          const provider = providerOf(entry.provider);
          return !provider.keyless && provider.terms !== "byok" && provider.kind !== "anthropic";
        }),
      ).toBe(true);
      const ranks = entries.slice(firstKeyless).map((entry) => rank(entry.provider));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(ranks[0]).toBe(0);
    }
  });

  it("serves every role with no environment at all in the public demo", () => {
    const config = parseModelsConfig(rootConfig);
    for (const role of ["planner", "worker", "fast"] as const) {
      const chain = resolveChain(
        role,
        {},
        { config, audience: "public-demo", environment: "server", classification: "public" },
      );
      expect(chain.length).toBeGreaterThan(0);
      expect(chain.every((entry) => entry.provider.keyless)).toBe(true);
    }
  });

  it("caps keyless community providers at public data", () => {
    const config = parseModelsConfig(rootConfig);
    for (const provider of config.providers) {
      if (provider.keyless && provider.terms === "public-demo-ok") {
        expect(provider.maxClassification).toBe("public");
      }
    }
  });

  it("prices every BYOK model and nothing else", () => {
    const config = parseModelsConfig(rootConfig);
    for (const provider of config.providers) {
      expect(provider.pricing !== undefined).toBe(provider.terms === "byok");
    }
  });
});

describe("ModelsConfigSchema", () => {
  it("rejects role entries pointing at unknown providers", () => {
    expect(() =>
      parseModelsConfig({
        version: 1,
        providers: [],
        roles: {
          planner: [{ provider: "ghost", model: "m", contextWindow: 1, supportsTools: true }],
          worker: [],
          fast: [],
        },
      }),
    ).toThrow(/ghost/);
  });

  it("requires an api key env var for keyed providers and pricing for BYOK models", () => {
    const base = {
      id: "p",
      kind: "openai-compatible",
      baseUrl: "https://p.test/v1",
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "x",
    };
    const roles = {
      planner: [{ provider: "p", model: "m", contextWindow: 1, supportsTools: true }],
      worker: [],
      fast: [],
    };
    expect(() =>
      parseModelsConfig({ version: 1, providers: [{ ...base, keyless: false }], roles }),
    ).toThrow(/apiKeyEnv/);
    expect(() =>
      parseModelsConfig({
        version: 1,
        providers: [{ ...base, kind: "anthropic", keyless: false, apiKeyEnv: "K", terms: "byok" }],
        roles,
      }),
    ).toThrow(/pricing/);
  });

  it("rejects unknown keys", () => {
    expect(() => ModelsConfigSchema.parse({ ...(rootConfig as object), extra: true })).toThrow();
  });
});

describe("resolveChain", () => {
  it("keeps only keyless hosted providers when nothing is configured", () => {
    expect(chainIds({}, server)).toEqual(["keyless"]);
  });

  it("includes the browser model only in the browser", () => {
    expect(
      chainIds({}, { audience: "public-demo", environment: "browser", classification: "public" }),
    ).toEqual(["keyless", "browser"]);
  });

  it("includes local models only on explicit opt-in", () => {
    expect(chainIds({}, { ...server, localOptIn: true })).toEqual(["keyless", "local"]);
  });

  it("includes keyed providers when their env vars are present and keeps config order", () => {
    expect(
      chainIds({ TRIAL_KEY: "t", FREE_KEY: "f", FREE_ACCOUNT: "acc", CLAUDE_KEY: "c" }, server),
    ).toEqual(["keyless", "trial", "free", "claude"]);
  });

  it("ignores empty env values and missing companion env vars", () => {
    expect(chainIds({ TRIAL_KEY: "", FREE_KEY: "f" }, server)).toEqual(["keyless"]);
  });

  it("excludes evaluation-only providers from the public demo", () => {
    expect(
      chainIds(
        { TRIAL_KEY: "t", FREE_KEY: "f", FREE_ACCOUNT: "acc" },
        { audience: "public-demo", environment: "server", classification: "public" },
      ),
    ).toEqual(["keyless", "free"]);
  });

  it("never spends the owner's BYOK key in the public demo but accepts a visitor key", () => {
    const demo = {
      audience: "public-demo",
      environment: "server",
      classification: "public",
    } as const;
    expect(chainIds({ CLAUDE_KEY: "owner" }, demo)).toEqual(["keyless"]);
    expect(chainIds({}, { ...demo, byokKeys: { claude: "sk-visitor" } })).toEqual([
      "keyless",
      "claude",
    ]);
  });

  it("includes a BYOK provider only when a non-empty key is actually supplied", () => {
    const demo = {
      audience: "public-demo",
      environment: "server",
      classification: "public",
    } as const;
    expect(chainIds({}, { ...demo, byokKeys: { claude: "" } })).toEqual(["keyless"]);
    expect(chainIds({}, { ...demo, byokKeys: { claude: "   " } })).toEqual(["keyless"]);
    expect(chainIds({}, { ...demo, byokKeys: { keyless: "sk" } })).toEqual(["keyless"]);
  });

  it("routes only to providers allowed for the data classification", () => {
    const everything = { TRIAL_KEY: "t", FREE_KEY: "f", FREE_ACCOUNT: "acc", CLAUDE_KEY: "c" };
    const owner = { ...server, localOptIn: true };
    expect(chainIds(everything, { ...owner, classification: "public" })).toEqual([
      "keyless",
      "local",
      "trial",
      "free",
      "claude",
    ]);
    expect(chainIds(everything, { ...owner, classification: "internal" })).toEqual([
      "local",
      "free",
      "claude",
    ]);
    expect(chainIds(everything, { ...owner, classification: "confidential" })).toEqual([
      "local",
      "claude",
    ]);
    expect(chainIds(everything, { ...owner, classification: "restricted" })).toEqual(["local"]);
  });

  it("treats a missing classification as internal", () => {
    const { classification: _omitted, ...unclassified } = server;
    expect(
      chainIds(
        { FREE_KEY: "f", FREE_ACCOUNT: "acc" },
        unclassified as Omit<ChainContext, "config">,
      ),
    ).toEqual(["free"]);
  });

  it("skips non-interactive entries unless the run has no latency budget", () => {
    const models = (latency?: "interactive" | "offline") =>
      resolveChain(
        "worker",
        { TRIAL_KEY: "t" },
        { config: fixture, ...server, ...(latency === undefined ? {} : { latency }) },
      ).map((entry) => entry.model);
    expect(models()).toEqual(["t-2", "k-2"]);
    expect(models("interactive")).toEqual(["t-2", "k-2"]);
    expect(models("offline")).toEqual(["t-slow", "t-2", "k-2"]);
  });

  it("returns entry details with quirks defaulted", () => {
    const [trial] = resolveChain(
      "planner",
      { TRIAL_KEY: "t" },
      { config: fixture, ...server },
    ).filter((entry) => entry.provider.id === "trial");
    expect(trial).toMatchObject({
      model: "t-1",
      contextWindow: 256000,
      quirks: ["echo-reasoning-content"],
      unverified: false,
      interactive: true,
    });
  });
});

describe("provider limits", () => {
  it("accepts a maximum number of concurrent requests", () => {
    expect(
      ProviderConfigSchema.parse({
        id: "p",
        kind: "openai-compatible",
        baseUrl: "https://p.test/v1",
        keyless: true,
        terms: "public-demo-ok",
        maxClassification: "public",
        dataPolicy: "x",
        limits: { requestsPerMinute: 10, maxConcurrent: 1 },
      }).limits?.maxConcurrent,
    ).toBe(1);
  });
});

describe("reasoning effort", () => {
  it("passes an optional per-entry reasoningEffort through to the chain entry", () => {
    const config = parseModelsConfig({
      version: 1,
      providers: [
        {
          id: "keyless",
          kind: "openai-compatible",
          baseUrl: "https://keyless.test/v1",
          keyless: true,
          terms: "public-demo-ok",
          maxClassification: "public",
          dataPolicy: "community",
        },
      ],
      roles: {
        planner: [
          {
            provider: "keyless",
            model: "k",
            contextWindow: 1000,
            supportsTools: true,
            reasoningEffort: "low",
          },
        ],
        worker: [{ provider: "keyless", model: "k", contextWindow: 1000, supportsTools: true }],
        fast: [],
      },
    });
    const context = { config, ...server };
    expect(resolveChain("planner", {}, context)[0]?.reasoningEffort).toBe("low");
    expect(resolveChain("worker", {}, context)[0]?.reasoningEffort).toBeUndefined();
    expect(() =>
      parseModelsConfig({
        ...config,
        roles: {
          ...config.roles,
          fast: [
            {
              provider: "keyless",
              model: "k",
              contextWindow: 1,
              supportsTools: true,
              reasoningEffort: "max",
            },
          ],
        },
      }),
    ).toThrow();
  });
});

describe("resolveBaseUrl", () => {
  const provider = (overrides: Record<string, unknown>) =>
    ProviderConfigSchema.parse({
      id: "p",
      kind: "openai-compatible",
      keyless: true,
      terms: "public-demo-ok",
      maxClassification: "public",
      dataPolicy: "x",
      baseUrl: "https://p.test/v1",
      ...overrides,
    });

  it("requires https for hosted providers", () => {
    expect(resolveBaseUrl(provider({}), {})).toBe("https://p.test/v1");
    expect(() => resolveBaseUrl(provider({ baseUrl: "http://p.test/v1" }), {})).toThrow(/https/);
    expect(() => resolveBaseUrl(provider({ baseUrl: "ftp://p.test/v1" }), {})).toThrow(/https/);
    expect(() => resolveBaseUrl(provider({ baseUrl: "not a url" }), {})).toThrow();
  });

  it("allows http only for Ollama and local-only providers on loopback", () => {
    expect(
      resolveBaseUrl(
        provider({ kind: "ollama", terms: "local-only", baseUrl: "http://localhost:11434/v1" }),
        {},
      ),
    ).toBe("http://localhost:11434/v1");
    expect(
      resolveBaseUrl(provider({ terms: "local-only", baseUrl: "http://127.0.0.1:8080/v1" }), {}),
    ).toBe("http://127.0.0.1:8080/v1");
    expect(() =>
      resolveBaseUrl(provider({ terms: "local-only", baseUrl: "http://10.0.0.5/v1" }), {}),
    ).toThrow(/https/);
  });

  it("rejects an insecure base URL when the config is parsed", () => {
    expect(() =>
      parseModelsConfig({
        version: 1,
        providers: [
          {
            id: "p",
            kind: "openai-compatible",
            baseUrl: "http://p.test/v1",
            keyless: true,
            terms: "public-demo-ok",
            maxClassification: "public",
            dataPolicy: "x",
          },
        ],
        roles: { planner: [], worker: [], fast: [] },
      }),
    ).toThrow(/https/);
  });

  it("substitutes env placeholders", () => {
    const free = fixture.providers.find((provider) => provider.id === "free");
    if (free === undefined) throw new Error("fixture");
    expect(resolveBaseUrl(free, { FREE_ACCOUNT: "acc" })).toBe("https://free.test/accounts/acc/v1");
    expect(() => resolveBaseUrl(free, {})).toThrow(/FREE_ACCOUNT/);
  });
});
