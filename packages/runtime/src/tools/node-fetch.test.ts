import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPinnedFetch } from "./node-fetch";

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      response.end(gzipSync("compressed hello"));
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
