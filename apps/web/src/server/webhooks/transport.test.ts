import { createPinnedFetch } from "@delegate/runtime/server";
import { describe, expect, it } from "vitest";

import {
  maxAttemptsFor,
  planRetry,
  retryDelayMs,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_AFTER_CEILING_MS,
  WEBHOOK_RETRY_DELAYS_MS,
} from "./policy";
import { createWebhookTransport, redactExcerpt, WEBHOOK_EXCERPT_MAX_CHARS } from "./transport";
import { assertPublicHost, validateWebhookUrl, WebhookUrlError } from "./url";

const PUBLIC = "93.184.215.14";
const WITH_CREDENTIALS = `https://${["user", "pw"].join(":")}@hooks.example.com/`;

function problemOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof WebhookUrlError) return error.problem;
    throw error;
  }
  return "accepted";
}

describe("webhook URL validation", () => {
  it("accepts a public https URL and drops the fragment", () => {
    expect(validateWebhookUrl(" https://hooks.example.com/delegate?team=a#frag ").href).toBe(
      "https://hooks.example.com/delegate?team=a",
    );
  });

  it("refuses plain http, credentials, odd ports and non-URLs", () => {
    expect(problemOf(() => validateWebhookUrl("http://hooks.example.com/x"))).toBe(
      "https_required",
    );
    expect(problemOf(() => validateWebhookUrl(WITH_CREDENTIALS))).toBe("credentials");
    expect(problemOf(() => validateWebhookUrl("https://hooks.example.com:8443/"))).toBe("port");
    expect(problemOf(() => validateWebhookUrl("not a url"))).toBe("invalid_url");
    expect(problemOf(() => validateWebhookUrl("ftp://hooks.example.com/"))).toBe("scheme");
    expect(
      problemOf(() => validateWebhookUrl(`https://hooks.example.com/${"a".repeat(2100)}`)),
    ).toBe("too_long");
  });

  it("refuses private, loopback, link-local and metadata addresses and local names", () => {
    for (const url of [
      "https://10.0.0.5/hook",
      "https://192.168.1.10/hook",
      "https://172.16.4.4/hook",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00::1]/hook",
      "https://[fe80::1]/hook",
      "https://2130706433/hook",
      "https://0x7f.0.0.1/hook",
      "https://localhost/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://printer.local/hook",
      "https://db.internal/hook",
      "https://93.184.215.14/hook",
    ]) {
      expect(
        problemOf(() => validateWebhookUrl(url)),
        url,
      ).toBe("blocked_host");
    }
  });

  it("refuses a host that resolves to any private address, or not at all", async () => {
    const url = new URL("https://hooks.example.com/x");
    const failure = async (addresses: string[] | Error) => {
      try {
        await assertPublicHost(url, () =>
          addresses instanceof Error ? Promise.reject(addresses) : Promise.resolve(addresses),
        );
      } catch (error) {
        if (error instanceof WebhookUrlError) return error.problem;
        throw error;
      }
      return "accepted";
    };
    expect(await failure([PUBLIC])).toBe("accepted");
    expect(await failure(["10.1.2.3"])).toBe("private_address");
    expect(await failure([PUBLIC, "127.0.0.1"])).toBe("private_address");
    expect(await failure(["169.254.169.254"])).toBe("private_address");
    expect(await failure(["::ffff:10.0.0.1"])).toBe("private_address");
    expect(await failure([])).toBe("unresolvable");
    expect(await failure(new Error("SERVFAIL"))).toBe("unresolvable");
  });
});

const REQUEST = {
  url: "https://hooks.example.com/delegate",
  headers: { "content-type": "application/json" },
  body: '{"id":"1"}',
};

function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  };
  return { calls, fetchImpl };
}

describe("webhook transport", () => {
  it("posts once with redirects set to manual and reports the status", async () => {
    const network = recordingFetch(() => new Response("thanks", { status: 202 }));
    const send = createWebhookTransport({
      fetchImpl: network.fetchImpl,
      resolveDns: () => Promise.resolve([PUBLIC]),
    });
    expect(await send(REQUEST)).toEqual({
      kind: "response",
      status: 202,
      excerpt: "thanks",
      retryAfterMs: null,
    });
    expect(network.calls).toHaveLength(1);
    expect(network.calls[0]?.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: REQUEST.body,
    });
  });

  it("never follows a redirect, wherever it points", async () => {
    for (const location of [
      "http://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/internal",
      "https://elsewhere.example.com/hook",
    ]) {
      const network = recordingFetch(
        () => new Response(null, { status: 302, headers: { location } }),
      );
      const send = createWebhookTransport({
        fetchImpl: network.fetchImpl,
        resolveDns: () => Promise.resolve([PUBLIC]),
      });
      const outcome = await send(REQUEST);
      expect(outcome).toMatchObject({ kind: "response", status: 302 });
      expect(network.calls.map((call) => call.url)).toEqual([REQUEST.url]);
    }
  });

  it("sends nothing when the URL is not allowed or the host resolves privately", async () => {
    const network = recordingFetch(() => new Response("ok"));
    const privately = createWebhookTransport({
      fetchImpl: network.fetchImpl,
      resolveDns: () => Promise.resolve(["10.0.0.7"]),
    });
    expect(await privately(REQUEST)).toEqual({ kind: "blocked", problem: "private_address" });
    const publicly = createWebhookTransport({
      fetchImpl: network.fetchImpl,
      resolveDns: () => Promise.resolve([PUBLIC]),
    });
    expect(await publicly({ ...REQUEST, url: "https://127.0.0.1/hook" })).toEqual({
      kind: "blocked",
      problem: "blocked_host",
    });
    expect(await publicly({ ...REQUEST, url: "http://hooks.example.com/hook" })).toEqual({
      kind: "blocked",
      problem: "https_required",
    });
    expect(network.calls).toEqual([]);
  });

  it("blocks DNS rebinding at connect time with the pinned fetch", async () => {
    let lookups = 0;
    const resolveDns = () => {
      lookups += 1;
      return Promise.resolve(lookups === 1 ? [PUBLIC] : ["127.0.0.1"]);
    };
    const send = createWebhookTransport({
      fetchImpl: createPinnedFetch(resolveDns),
      resolveDns,
      timeoutMs: 3_000,
    });
    expect(await send(REQUEST)).toEqual({ kind: "blocked", problem: "private_address" });
    expect(lookups).toBe(2);
  });

  it("reports timeouts and network failures without throwing", async () => {
    const hanging = createWebhookTransport({
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      resolveDns: () => Promise.resolve([PUBLIC]),
      timeoutMs: 20,
    });
    expect(await hanging(REQUEST)).toEqual({ kind: "timeout" });
    const refused = createWebhookTransport({
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
      resolveDns: () => Promise.resolve([PUBLIC]),
    });
    expect(await refused(REQUEST)).toEqual({ kind: "network" });
  });

  it("keeps only a short, redacted excerpt of the response", async () => {
    const secret = ["sk", "live", "0123456789abcdefghijklmnopqrstuv"].join("_");
    const body = `error for jane.doe@example.com token ${secret}\n\u0000\u001b[31m${"z ".repeat(2_000)}`;
    const network = recordingFetch(() => new Response(body, { status: 500 }));
    const send = createWebhookTransport({
      fetchImpl: network.fetchImpl,
      resolveDns: () => Promise.resolve([PUBLIC]),
    });
    const outcome = await send(REQUEST);
    if (outcome.kind !== "response") throw new Error("expected a response");
    expect(outcome.excerpt.length).toBeLessThanOrEqual(WEBHOOK_EXCERPT_MAX_CHARS);
    expect(outcome.excerpt).not.toContain("jane.doe@example.com");
    expect(outcome.excerpt).not.toContain(secret);
    expect(outcome.excerpt).toBe(redactExcerpt(outcome.excerpt));
    expect(outcome.excerpt).toMatch(/^[\x20-\x7e\u2026]*$/u);
    expect(redactExcerpt("  plain\n text  ")).toBe("plain text");
  });

  it("reads Retry-After as seconds or a date, bounded to a day", async () => {
    const at = Date.parse("2026-11-25T12:00:00Z");
    const outcomeFor = async (value: string) => {
      const send = createWebhookTransport({
        fetchImpl: () =>
          Promise.resolve(new Response("", { status: 429, headers: { "retry-after": value } })),
        resolveDns: () => Promise.resolve([PUBLIC]),
        now: () => at,
      });
      const outcome = await send(REQUEST);
      return outcome.kind === "response" ? outcome.retryAfterMs : undefined;
    };
    expect(await outcomeFor("120")).toBe(120_000);
    expect(await outcomeFor("Wed, 25 Nov 2026 12:10:00 GMT")).toBe(600_000);
    expect(await outcomeFor("999999999")).toBe(86_400_000);
    expect(await outcomeFor("soon")).toBeNull();
  });
});

describe("webhook retry schedule", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");

  it("backs off 1 min, 5 min, 30 min, 2 h, 8 h and then gives up", () => {
    const delays: number[] = [];
    for (let attemptsMade = 1; attemptsMade <= WEBHOOK_MAX_ATTEMPTS; attemptsMade += 1) {
      const plan = planRetry({ attemptsMade, maxAttempts: WEBHOOK_MAX_ATTEMPTS, now });
      if (plan.outcome === "failed") {
        expect(attemptsMade).toBe(WEBHOOK_MAX_ATTEMPTS);
        break;
      }
      delays.push(plan.nextAttemptAt.getTime() - now.getTime());
    }
    expect(delays).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 28_800_000]);
    expect(delays).toEqual([...WEBHOOK_RETRY_DELAYS_MS]);
    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(99)).toBe(28_800_000);
  });

  it("waits longer when the receiver asks, up to a day", () => {
    const asked = planRetry({ attemptsMade: 1, maxAttempts: 6, now, retryAfterMs: 900_000 });
    expect(asked).toEqual({ outcome: "retry", nextAttemptAt: new Date(now.getTime() + 900_000) });
    const shorter = planRetry({ attemptsMade: 2, maxAttempts: 6, now, retryAfterMs: 1_000 });
    expect(shorter).toEqual({ outcome: "retry", nextAttemptAt: new Date(now.getTime() + 300_000) });
    const forever = planRetry({ attemptsMade: 1, maxAttempts: 6, now, retryAfterMs: 10 ** 12 });
    expect(forever).toEqual({
      outcome: "retry",
      nextAttemptAt: new Date(now.getTime() + WEBHOOK_RETRY_AFTER_CEILING_MS),
    });
  });

  it("never retries a test delivery", () => {
    expect(maxAttemptsFor("webhook.test")).toBe(1);
    expect(maxAttemptsFor("run.completed")).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(
      planRetry({ attemptsMade: 1, maxAttempts: maxAttemptsFor("webhook.test"), now }),
    ).toEqual({
      outcome: "failed",
    });
  });
});
