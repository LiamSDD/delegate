import { describe, expect, it, vi } from "vitest";

import { startCompanyXray } from "./start-run";

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    ),
  );
}

describe("startCompanyXray", () => {
  it("posts the mission and returns the run id", async () => {
    const fetcher = respond(201, { runId: "5d1f6a0e-8b8f-4f53-9a43-3f0f1d2b7c11" });
    const result = await startCompanyXray({ url: "acme.com" }, fetcher);
    expect(result).toEqual({ ok: true, runId: "5d1f6a0e-8b8f-4f53-9a43-3f0f1d2b7c11" });
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(typeof init.body === "string" ? init.body : "")).toEqual({
      missionId: "company-xray",
      input: { url: "acme.com" },
    });
  });

  it("surfaces typed API errors and rate-limit waits", async () => {
    const limited = await startCompanyXray(
      { url: "acme.com" },
      respond(
        429,
        { error: { code: "rate_limited", message: "Slow down" } },
        { "retry-after": "120" },
      ),
    );
    expect(limited).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Slow down",
      retryAfterSeconds: 120,
    });
    const odd = await startCompanyXray({ url: "acme.com" }, respond(502, "<html>"));
    expect(odd).toMatchObject({ ok: false, code: "unexpected" });
  });

  it("reports network failures", async () => {
    const result = await startCompanyXray({ url: "acme.com" }, () =>
      Promise.reject(new TypeError("offline")),
    );
    expect(result).toMatchObject({ ok: false, code: "network" });
  });
});
