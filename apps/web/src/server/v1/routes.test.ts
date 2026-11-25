import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { API_BASE_PATH, buildOpenApiDocument, OPERATIONS } from "@delegate/sdk/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { handleOpenApi } from "./router";

const V1_DIR = path.join(import.meta.dirname, "..", "..", "app", "api", "v1");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const CATCH_ALL = "[[...unknown]]";

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

function openApiPath(file: string): string {
  const segments = path.relative(V1_DIR, path.dirname(file)).split(path.sep);
  return `/${segments
    .filter((segment) => segment !== "")
    .map((segment) => segment.replace(/^\[(\w+)\]$/, "{$1}"))
    .join("/")}`;
}

const RouteModuleSchema = z.record(z.string(), z.unknown());

async function exportedRoutes(): Promise<Map<string, unknown>> {
  const routes = new Map<string, unknown>();
  for (const file of routeFiles(V1_DIR)) {
    if (file.includes(CATCH_ALL)) continue;
    const loaded = RouteModuleSchema.parse(await import(pathToFileURL(file).href));
    for (const method of HTTP_METHODS)
      if (loaded[method] !== undefined)
        routes.set(`${method} ${openApiPath(file)}`, loaded[method]);
  }
  return routes;
}

const DocumentSchema = z.object({
  openapi: z.string(),
  servers: z.array(z.object({ url: z.string() })),
  paths: z.record(z.string(), z.record(z.string(), z.object({ operationId: z.string() }))),
});

function documentedRoutes(): Map<string, string> {
  const document = DocumentSchema.parse(buildOpenApiDocument());
  const documented = new Map<string, string>();
  for (const [route, methods] of Object.entries(document.paths))
    for (const [method, operation] of Object.entries(methods))
      documented.set(`${method.toUpperCase()} ${route}`, operation.operationId);
  return documented;
}

describe("v1 routes and the OpenAPI document", () => {
  it("documents every route file and has a route file for every documented operation", async () => {
    const routes = await exportedRoutes();
    const documented = documentedRoutes();
    expect([...routes.keys()].sort()).toEqual([...documented.keys()].sort());
    expect(documented.size).toBe(Object.keys(OPERATIONS).length);
  });

  it("binds every route to the operation the document names for that method and path", async () => {
    const routes = await exportedRoutes();
    const documented = documentedRoutes();
    for (const [route, handler] of routes) {
      const operationId: unknown =
        typeof handler === "function" ? Reflect.get(handler, "operationId") : undefined;
      expect(typeof operationId, `${route} is not built with v1Route`).toBe("string");
      expect(operationId, route).toBe(documented.get(route));
    }
  });

  it("serves the generated document under the documented base path", async () => {
    const served: unknown = await handleOpenApi().json();
    expect(served).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
    const document = DocumentSchema.parse(served);
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers.some((server) => server.url.endsWith(API_BASE_PATH))).toBe(true);
  });

  it("answers unknown v1 paths in the error envelope for every method", async () => {
    const file = routeFiles(V1_DIR).find((candidate) => candidate.includes(CATCH_ALL));
    if (file === undefined) throw new Error("the v1 catch-all route is missing");
    const loaded = RouteModuleSchema.parse(await import(pathToFileURL(file).href));
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const handler = z
        .custom<(request: Request) => Promise<Response>>((value) => typeof value === "function")
        .parse(loaded[method]);
      const response = await handler(
        new Request(`https://delegate.example${API_BASE_PATH}/nope/${"x".repeat(300)}`, { method }),
      );
      expect(response.status).toBe(404);
      const body = z
        .object({
          error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }),
        })
        .parse(await response.json());
      expect(body.error.code).toBe("not_found");
      expect(body.error.message.length).toBeLessThan(300);
    }
  });
});
