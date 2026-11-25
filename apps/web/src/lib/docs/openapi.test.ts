import { describe, expect, it } from "vitest";

import { parseOpenApi, typeLabel } from "./openapi";

const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Delegate API", version: "1.0.0", description: "Runs and artifacts." },
  servers: [{ url: "https://example.test/api/v1", description: "This deployment" }],
  security: [{ bearer: [] }],
  tags: [{ name: "Runs", description: "Start and read runs." }],
  paths: {
    "/runs": {
      post: {
        tags: ["Runs"],
        summary: "Start a run",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/StartRun" } } },
        },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Run" } } },
          },
          "429": { description: "Rate limited" },
        },
      },
      get: {
        tags: ["Runs"],
        summary: "List runs",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", format: "int32" } },
          { $ref: "#/components/parameters/Cursor" },
          { nonsense: true },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Run" } },
              },
            },
          },
        },
      },
    },
    "/runs/{runId}": {
      parameters: [{ name: "runId", in: "path", schema: { type: "string", format: "uuid" } }],
      get: { summary: "Get a run", security: [], responses: {} },
      delete: "not an operation",
    },
  },
  components: {
    parameters: { Cursor: { name: "cursor", in: "query", description: "Opaque cursor" } },
    securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "dlg_ token" } },
    schemas: {
      StartRun: {
        type: "object",
        required: ["missionId"],
        properties: {
          missionId: { enum: ["company-xray", "repo-xray"], description: "Which mission" },
          input: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      Run: {
        type: "object",
        description: "A run.",
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: ["string", "null"] },
          parent: { anyOf: [{ $ref: "#/components/schemas/Run" }, { type: "null" }] },
        },
      },
    },
  },
};

describe("parseOpenApi", () => {
  const model = parseOpenApi(DOCUMENT);

  it("reads the document header, servers and security schemes", () => {
    expect(model).toMatchObject({
      title: "Delegate API",
      version: "1.0.0",
      specVersion: "3.1.0",
      description: "Runs and artifacts.",
      servers: [{ url: "https://example.test/api/v1", description: "This deployment" }],
      security: [{ name: "bearer", summary: "Authorization: Bearer <token> (dlg_ token)" }],
    });
  });

  it("groups operations by tag in a stable method order with unique anchors", () => {
    expect(model?.groups.map((group) => [group.name, group.operations.map((op) => op.id)])).toEqual(
      [
        ["Runs", ["get-runs", "post-runs"]],
        ["Endpoints", ["get-runs-runid"]],
      ],
    );
  });

  it("resolves parameters, request bodies and responses", () => {
    const [list, start] = model?.groups[0]?.operations ?? [];
    expect(list?.parameters).toEqual([
      { name: "limit", in: "query", required: false, type: "integer (int32)", description: null },
      { name: "cursor", in: "query", required: false, type: "any", description: "Opaque cursor" },
    ]);
    expect(list?.responses[0]?.contents[0]?.schema?.type).toBe("Run[]");
    expect(list?.responses[0]?.contents[0]?.schema?.properties.map((p) => p.name)).toEqual([
      "id",
      "status",
      "parent",
    ]);
    expect(start?.security).toEqual(["bearer"]);
    expect(start?.requestBody).toMatchObject({ required: true });
    expect(start?.requestBody?.contents[0]?.schema).toEqual({
      type: "StartRun",
      description: null,
      properties: [
        {
          name: "missionId",
          type: '"company-xray" | "repo-xray"',
          required: true,
          description: "Which mission",
        },
        { name: "input", type: "Record<string, string>", required: false, description: null },
      ],
    });
    expect(start?.responses.map((response) => response.status)).toEqual(["201", "429"]);
  });

  it("inherits path parameters and lets an operation opt out of authentication", () => {
    const get = model?.groups[1]?.operations[0];
    expect(get?.parameters).toEqual([
      { name: "runId", in: "path", required: true, type: "string (uuid)", description: null },
    ]);
    expect(get?.security).toEqual([]);
  });

  it("lists component schemas with their properties", () => {
    expect(model?.schemas.map((schema) => [schema.name, schema.id, schema.view.type])).toEqual([
      ["StartRun", "schema-startrun", "object"],
      ["Run", "schema-run", "object"],
    ]);
    expect(model?.schemas[1]?.view.properties).toContainEqual({
      name: "parent",
      type: "Run | null",
      required: false,
      description: null,
    });
  });

  it.each([null, "text", [], {}, { openapi: "2.0", info: {}, paths: {} }, { openapi: "3.1.0" }])(
    "rejects %j",
    (value) => {
      expect(parseOpenApi(value)).toBeNull();
    },
  );

  it("accepts a minimal document", () => {
    expect(
      parseOpenApi({ openapi: "3.0.3", info: { title: "T", version: "1" }, paths: {} }),
    ).toEqual({
      title: "T",
      version: "1",
      specVersion: "3.0.3",
      description: null,
      servers: [],
      security: [],
      groups: [],
      schemas: [],
    });
  });
});

describe("typeLabel", () => {
  it.each([
    [{ type: "string" }, "string"],
    [{ type: "string", format: "date-time" }, "string (date-time)"],
    [{ type: "array", items: { type: "number" } }, "number[]"],
    [{ type: "string", nullable: true }, "string | null"],
    [{ const: "run" }, '"run"'],
    [{ enum: [1, 2] }, "1 | 2"],
    [{ allOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }] }, "A & B"],
    [{ properties: { a: {} } }, "object"],
    [{}, "any"],
    ["nonsense", "any"],
  ])("labels %j as %s", (schema, expected) => {
    expect(typeLabel(schema)).toBe(expected);
  });

  it("stops at a fixed depth on self-referential inline schemas", () => {
    const loop: Record<string, unknown> = { type: "array" };
    loop.items = loop;
    expect(typeLabel(loop)).toBe("any[][][][][]");
  });
});
