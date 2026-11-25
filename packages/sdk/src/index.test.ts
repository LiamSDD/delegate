import { describe, expect, it } from "vitest";

import { createDelegateClient, DelegateApiError, packageName } from "./index";

const RUN_ID = "7d1d4f3e-2b8e-4c41-9e0f-3c2b1a0d9e8f";

function recordingFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(respond(url, init ?? {}));
  };
  return { impl, calls };
}

describe("@delegate/sdk", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@delegate/sdk");
  });

  it("sends the bearer token and returns the run's web URL", async () => {
    const fake = recordingFetch(() => Response.json({ runId: RUN_ID }, { status: 201 }));
    const client = createDelegateClient({
      baseUrl: "https://delegate.example/ignored/path",
      token: "dlg_test",
      fetch: fake.impl,
    });
    const started = await client.startRun({
      missionId: "company-xray",
      input: { url: "acme.example" },
    });
    expect(started).toEqual({ runId: RUN_ID, webUrl: `https://delegate.example/runs/${RUN_ID}` });
    expect(fake.calls[0]?.url).toBe("https://delegate.example/api/runs");
    expect(new Headers(fake.calls[0]?.init.headers).get("authorization")).toBe("Bearer dlg_test");
    expect(fake.calls[0]?.init.redirect).toBe("error");
  });

  it("turns API errors into DelegateApiError", async () => {
    const fake = recordingFetch(() =>
      Response.json({ error: { code: "not_found", message: "No run" } }, { status: 404 }),
    );
    const client = createDelegateClient({
      baseUrl: "https://delegate.example",
      token: "dlg_test",
      fetch: fake.impl,
    });
    await expect(client.getRun(RUN_ID)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(client.getRun(RUN_ID)).rejects.toBeInstanceOf(DelegateApiError);
  });

  it("refuses plain http except for localhost", () => {
    expect(() => createDelegateClient({ baseUrl: "http://delegate.example", token: "t" })).toThrow(
      /https/,
    );
    expect(createDelegateClient({ baseUrl: "http://localhost:3000", token: "t" }).baseUrl).toBe(
      "http://localhost:3000",
    );
  });

  it("validates responses against the REST contract", async () => {
    const fake = recordingFetch(() => Response.json({ runs: [{ id: "not-a-uuid" }] }));
    const client = createDelegateClient({
      baseUrl: "https://delegate.example",
      token: "dlg_test",
      fetch: fake.impl,
    });
    await expect(client.listRuns()).rejects.toThrow();
  });
});
