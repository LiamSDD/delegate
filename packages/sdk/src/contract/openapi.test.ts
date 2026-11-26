import { describe, expect, it } from "vitest";

import { API_ERROR_CODES, API_ERROR_STATUS } from "./errors";
import { COMPONENT_SCHEMAS, buildOpenApiDocument, openApiRoutes } from "./openapi";
import { OPERATION_IDS, OPERATIONS, operationErrors, operationPath } from "./operations";
import { WEBHOOK_EVENT_TYPES } from "./webhooks";

const document = buildOpenApiDocument();

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  visit(node);
  for (const entry of Object.values(node)) walk(entry, visit);
}

function resolve(pointer: string): unknown {
  expect(pointer.startsWith("#/")).toBe(true);
  let current: unknown = document;
  for (const part of pointer.slice(2).split("/")) {
    expect(current, pointer).toBeTypeOf("object");
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

describe("OpenAPI document", () => {
  it("is OpenAPI 3.1, plain JSON and the same on every build", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    expect(buildOpenApiDocument()).toEqual(document);
  });

  it("lists every operation of the contract exactly once", () => {
    expect(openApiRoutes(document)).toEqual(
      OPERATION_IDS.map((id) => `${OPERATIONS[id].method} ${OPERATIONS[id].path}`).sort(),
    );
    const ids: string[] = [];
    for (const methods of Object.values(document.paths))
      for (const operation of Object.values(methods)) ids.push(String(operation.operationId));
    expect(ids.sort()).toEqual([...OPERATION_IDS].sort());
  });

  it("resolves every $ref and carries no JSON Schema dialect keys", () => {
    let refs = 0;
    walk(document, (node) => {
      expect(node).not.toHaveProperty("$schema");
      expect(node).not.toHaveProperty("$id");
      if (typeof node.$ref === "string") {
        refs += 1;
        expect(resolve(node.$ref), node.$ref).toBeDefined();
      }
    });
    expect(refs).toBeGreaterThan(40);
  });

  it("publishes a component for every named schema", () => {
    expect(Object.keys(document.components.schemas).sort()).toEqual(
      Object.keys(COMPONENT_SCHEMAS).sort(),
    );
  });

  it("declares every path parameter and marks it required", () => {
    for (const [path, methods] of Object.entries(document.paths)) {
      const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      for (const operation of Object.values(methods)) {
        const declared = (operation.parameters as { name?: string; in?: string }[])
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name);
        expect(declared.sort(), path).toEqual([...names].sort());
      }
    }
  });

  it("documents the status of every error code an operation can answer with", () => {
    for (const id of OPERATION_IDS) {
      const spec = OPERATIONS[id];
      const operation = document.paths[spec.path]?.[spec.method.toLowerCase()];
      const responses = operation?.responses as Record<string, { description: string }>;
      expect(responses[String(spec.status)], id).toBeDefined();
      for (const code of operationErrors(spec)) {
        const response = responses[String(API_ERROR_STATUS[code])];
        expect(response?.description, `${id} ${code}`).toContain(`\`${code}\``);
      }
    }
  });

  it("requires a bearer token everywhere except for the document itself", () => {
    for (const id of OPERATION_IDS) {
      const spec = OPERATIONS[id];
      const operation = document.paths[spec.path]?.[spec.method.toLowerCase()];
      expect(operation?.security, id).toEqual(spec.authenticated ? [{ bearerAuth: [] }] : []);
    }
    expect(OPERATION_IDS.filter((id) => !OPERATIONS[id].authenticated)).toEqual(["getOpenApi"]);
  });

  it("offers Idempotency-Key on every POST and nowhere else", () => {
    for (const id of OPERATION_IDS) {
      const spec = OPERATIONS[id];
      const operation = document.paths[spec.path]?.[spec.method.toLowerCase()];
      const offered = (operation?.parameters as { $ref?: string }[]).some(
        (parameter) => parameter.$ref === "#/components/parameters/IdempotencyKey",
      );
      expect(offered, id).toBe(spec.method === "POST");
      expect(spec.idempotencyKey, id).toBe(spec.method === "POST");
    }
  });

  it("describes the event stream alternative of both streaming operations", () => {
    const streaming = OPERATION_IDS.filter((id) => OPERATIONS[id].eventStream !== null);
    expect(streaming.sort()).toEqual(["chatWithAssistant", "listRunEvents"]);
    for (const id of streaming) {
      const spec = OPERATIONS[id];
      const operation = document.paths[spec.path]?.[spec.method.toLowerCase()];
      const success = (operation?.responses as Record<string, { content: object }>)[
        String(spec.status)
      ];
      expect(Object.keys(success?.content ?? {})).toEqual([
        "application/json",
        "text/event-stream",
      ]);
    }
  });

  it("documents the four webhook events with their signature headers", () => {
    expect(Object.keys(document.webhooks)).toEqual([...WEBHOOK_EVENT_TYPES]);
    for (const type of WEBHOOK_EVENT_TYPES) {
      const post = document.webhooks[type]?.post;
      const headers = (post?.parameters as { name: string }[]).map((parameter) => parameter.name);
      expect(headers).toEqual([
        "delegate-timestamp",
        "delegate-signature",
        "delegate-delivery",
        "delegate-event",
      ]);
    }
  });

  it("gives every error code a status", () => {
    expect(API_ERROR_CODES.length).toBe(Object.keys(API_ERROR_STATUS).length);
    for (const code of API_ERROR_CODES) expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
});

describe("operationPath", () => {
  it("fills and encodes path parameters under the v1 base path", () => {
    expect(
      operationPath(OPERATIONS.getArtifact, { runId: "r1", artifactId: "report/v1 final" }),
    ).toBe("/api/v1/runs/r1/artifacts/report%2Fv1%20final");
    expect(operationPath(OPERATIONS.listRuns, undefined)).toBe("/api/v1/runs");
  });

  it("refuses a missing parameter instead of building a wrong URL", () => {
    expect(() => operationPath(OPERATIONS.getRun, {})).toThrow(/runId/);
    expect(() => operationPath(OPERATIONS.getRun, { runId: "" })).toThrow(/runId/);
  });
});
