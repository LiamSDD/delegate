import { describe, expect, it } from "vitest";

import modelsConfig from "@config/models.json";

import { summariseLiveChain } from "./model-chain";

describe("summariseLiveChain", () => {
  it("leads with the free-key models when the key is present", () => {
    const chain = summariseLiveChain(modelsConfig, { NVIDIA_API_KEY: "present" });
    expect(chain.status).toBe("ok");
    if (chain.status !== "ok") return;
    expect(chain.models[0]).toEqual({ name: "MiniMax M3.1 Flash", keyless: false });
    expect(chain.models.some((model) => model.keyless)).toBe(true);
    expect(chain.models.map((model) => model.name)).not.toContain("Kimi K3.1 Pro");
  });

  it("falls back to keyless models when no key is set", () => {
    const chain = summariseLiveChain(modelsConfig, {});
    expect(chain.status).toBe("ok");
    if (chain.status !== "ok") return;
    expect(chain.models.every((model) => model.keyless)).toBe(true);
  });

  it("reports an invalid config", () => {
    expect(summariseLiveChain({ version: 2 }, {}).status).toBe("unavailable");
  });
});
