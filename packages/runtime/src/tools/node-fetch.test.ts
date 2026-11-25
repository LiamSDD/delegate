import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPinnedFetch, PINNED_FETCH_MAX_RESPONSE_BYTES } from "./node-fetch";

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      response.end(gzipSync("compressed hello"));
      return;
    }
    if (request.url === "/big") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(Buffer.alloc(PINNED_FETCH_MAX_RESPONSE_BYTES + 1, 97));
      return;
    }
    if (request.url === "/bomb") {
      response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      response.end(gzipSync(Buffer.alloc(8 * PINNED_FETCH_MAX_RESPONSE_BYTES)));
      return;
    }
    if (request.url === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = `data: ${"x".repeat(64 * 1024)}\n\n`;
      const timer = setInterval(() => {
        if (!response.write(event)) return;
      }, 1);
      response.on("close", () => {
        clearInterval(timer);
      });
      return;
    }
    if (request.url === "/echo") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`${request.method ?? ""} ${Buffer.concat(chunks).toString("utf8")}`);
      });
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/plain" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "x-host": request.headers.host ?? "" });
    response.end(`hello ${request.headers["user-agent"] ?? ""}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

describe("createPinnedFetch", () => {
  it("sends string request bodies", async () => {
    const pinned = createPinnedFetch(() => Promise.resolve(["127.0.0.1"]), {
      isAllowedAddress: () => true,
    });
    const response = await pinned(`http://pinned.test:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(await response.text()).toBe('POST {"jsonrpc":"2.0"}');
  });

  it("refuses to connect when the name resolves to a blocked address at connect time", async () => {
    const pinned = createPinnedFetch(() => Promise.resolve(["127.0.0.1"]));
    await expect(pinned(`http://rebind.test:${port}/plain`)).rejects.toThrow(/blocked|resolves/i);
  });

  it("connects to the address the resolver returned, keeping the Host header", async () => {
    const pinned = createPinnedFetch(() => Promise.resolve(["127.0.0.1"]), {
      isAllowedAddress: () => true,
    });
    const response = await pinned(`http://pinned.test:${port}/plain`, {
      headers: { "user-agent": "DelegateBot" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-host")).toBe(`pinned.test:${port}`);
    expect(await response.text()).toBe("hello DelegateBot");
  });

  it("decodes gzip bodies and leaves redirects to the caller", async () => {
    const pinned = createPinnedFetch(() => Promise.resolve(["127.0.0.1"]), {
      isAllowedAddress: () => true,
    });
    const gzip = await pinned(`http://pinned.test:${port}/gzip`);
    expect(await gzip.text()).toBe("compressed hello");
    const redirect = await pinned(`http://pinned.test:${port}/redirect`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/plain");
  });

  it("aborts a response whose decoded body passes the size cap, compressed or not", async () => {
    const pinned = createPinnedFetch(() => Promise.resolve(["127.0.0.1"]), {
      isAllowedAddress: () => true,
    });
    for (const path of ["/big", "/bomb"]) {
      const response = await pinned(`http://pinned.test:${port}${path}`);
      await expect(response.arrayBuffer()).rejects.toThrow(/larger than/);
    }
  });

  it("caps a streaming event-stream response the same way", async () => {
    const pinned = createPinnedFetch(() => Promise.resolve(["127.0.0.1"]), {
      isAllowedAddress: () => true,
      maxResponseBytes: 256 * 1024,
    });
    const response = await pinned(`http://pinned.test:${port}/sse`);
    const body: ReadableStream<Uint8Array> | null = response.body;
    if (body === null) throw new Error("body expected");
    const reader = body.getReader();
    let total = 0;
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
          if (done || value === undefined) return;
          total += value.byteLength;
        }
      })(),
    ).rejects.toThrow(/larger than/);
    expect(total).toBeLessThanOrEqual(256 * 1024);
  });

  it("honours abort signals", async () => {
    const pinned = createPinnedFetch(() => Promise.resolve(["127.0.0.1"]), {
      isAllowedAddress: () => true,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      pinned(`http://pinned.test:${port}/plain`, { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
