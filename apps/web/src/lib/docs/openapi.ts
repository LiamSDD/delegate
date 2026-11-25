import { z } from "zod";

import { slugify } from "./slug";

export const OPENAPI_PATH = "/api/v1/openapi.json";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const MAX_TYPE_DEPTH = 4;
const MAX_ENUM_VALUES = 8;

const Text = z.string().optional().catch(undefined);
const Json = z.record(z.string(), z.unknown());

const MediaSchema = z.record(z.string(), z.looseObject({ schema: z.unknown().optional() }));

const ParameterSchema = z.looseObject({
  name: z.string(),
  in: z.string(),
  required: z.boolean().optional().catch(undefined),
  description: Text,
  schema: z.unknown().optional(),
});

const OperationSchema = z.looseObject({
  summary: Text,
  description: Text,
  operationId: Text,
  deprecated: z.boolean().optional().catch(undefined),
  tags: z.array(z.string()).optional().catch(undefined),
  parameters: z.array(z.unknown()).optional().catch(undefined),
  requestBody: z
    .looseObject({
      description: Text,
      required: z.boolean().optional().catch(undefined),
      content: MediaSchema.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  responses: z
    .record(
      z.string(),
      z.looseObject({ description: Text, content: MediaSchema.optional().catch(undefined) }),
    )
    .optional()
    .catch(undefined),
  security: z.array(z.record(z.string(), z.unknown())).optional().catch(undefined),
});

const DocumentSchema = z.looseObject({
  openapi: z.string().regex(/^3\./),
  info: z.looseObject({ title: z.string(), version: z.string(), description: Text }),
  servers: z
    .array(z.looseObject({ url: z.string(), description: Text }))
    .optional()
    .catch(undefined),
  tags: z
    .array(z.looseObject({ name: z.string(), description: Text }))
    .optional()
    .catch(undefined),
  paths: z.record(z.string(), Json),
  security: z.array(z.record(z.string(), z.unknown())).optional().catch(undefined),
  components: z
    .looseObject({
      schemas: Json.optional().catch(undefined),
      parameters: Json.optional().catch(undefined),
      securitySchemes: z
        .record(
          z.string(),
          z.looseObject({
            type: z.string(),
            scheme: Text,
            bearerFormat: Text,
            in: Text,
            name: Text,
            description: Text,
          }),
        )
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

type Components = NonNullable<z.infer<typeof DocumentSchema>["components"]>;

export interface ApiProperty {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

export interface ApiSchemaView {
  type: string;
  description: string | null;
  properties: ApiProperty[];
}

export interface ApiContent {
  mediaType: string;
  schema: ApiSchemaView | null;
}

export interface ApiOperation {
  id: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  deprecated: boolean;
  security: string[] | null;
  parameters: (ApiProperty & { in: string })[];
  requestBody: { required: boolean; description: string | null; contents: ApiContent[] } | null;
  responses: { status: string; description: string | null; contents: ApiContent[] }[];
}

export interface ApiGroup {
  name: string;
  description: string | null;
  operations: ApiOperation[];
}

export interface ApiSecurityScheme {
  name: string;
  summary: string;
  description: string | null;
}

export interface ApiReferenceModel {
  title: string;
  version: string;
  specVersion: string;
  description: string | null;
  servers: { url: string; description: string | null }[];
  security: ApiSecurityScheme[];
  groups: ApiGroup[];
  schemas: { name: string; id: string; view: ApiSchemaView }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function refName(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  return /^#\/components\/[a-zA-Z]+\/([^/]+)$/.exec(ref)?.[1] ?? null;
}

function resolve(schema: unknown, bucket: Record<string, unknown> | undefined): unknown {
  if (!isRecord(schema)) return schema;
  const name = refName(schema.$ref);
  return name === null ? schema : bucket?.[name];
}

export function schemaId(name: string): string {
  return `schema-${slugify(name)}`;
}

function literal(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

export function typeLabel(schema: unknown, depth = 0): string {
  if (!isRecord(schema) || depth > MAX_TYPE_DEPTH) return "any";
  const reference = refName(schema.$ref);
  if (reference !== null) return reference;
  const union = (key: "oneOf" | "anyOf" | "allOf", joiner: string): string | null => {
    const members = schema[key];
    if (!Array.isArray(members) || members.length === 0) return null;
    return [...new Set(members.map((member) => typeLabel(member, depth + 1)))].join(joiner);
  };
  let label = union("oneOf", " | ") ?? union("anyOf", " | ") ?? union("allOf", " & ") ?? undefined;
  if (label === undefined && "const" in schema) label = literal(schema.const);
  if (label === undefined && Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, MAX_ENUM_VALUES).map(literal);
    label = `${values.join(" | ")}${schema.enum.length > MAX_ENUM_VALUES ? " | …" : ""}`;
  }
  if (label === undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    label = types
      .map((type): string => {
        if (type === "array") return `${typeLabel(schema.items, depth + 1)}[]`;
        if (type === "object" || (type === undefined && isRecord(schema.properties))) {
          const extra = schema.additionalProperties;
          return isRecord(extra) ? `Record<string, ${typeLabel(extra, depth + 1)}>` : "object";
        }
        if (typeof type !== "string") return "any";
        const format = text(schema.format);
        return format === null ? type : `${type} (${format})`;
      })
      .join(" | ");
  }
  return schema.nullable === true && !label.includes("null") ? `${label} | null` : label;
}

function schemaView(schema: unknown, components: Components | undefined): ApiSchemaView | null {
  if (schema === undefined) return null;
  const resolved = resolve(schema, components?.schemas);
  const target = isRecord(resolved) && resolved.type === "array" ? resolved.items : resolved;
  const body = resolve(target, components?.schemas);
  const required = new Set(
    isRecord(body) && Array.isArray(body.required)
      ? body.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const properties =
    isRecord(body) && isRecord(body.properties)
      ? Object.entries(body.properties).map(([name, property]): ApiProperty => ({
          name,
          type: typeLabel(property),
          required: required.has(name),
          description: isRecord(property) ? text(property.description) : null,
        }))
      : [];
  return {
    type: typeLabel(schema),
    description: isRecord(resolved) ? text(resolved.description) : null,
    properties,
  };
}

function contents(
  media: z.infer<typeof MediaSchema> | undefined,
  components: Components | undefined,
): ApiContent[] {
  return Object.entries(media ?? {}).map(([mediaType, entry]) => ({
    mediaType,
    schema: schemaView(entry.schema, components),
  }));
}

function securityNames(requirements: Record<string, unknown>[] | undefined): string[] | null {
  if (requirements === undefined) return null;
  return [...new Set(requirements.flatMap((requirement) => Object.keys(requirement)))];
}

function schemeSummary(scheme: {
  type: string;
  scheme?: string | undefined;
  bearerFormat?: string | undefined;
  in?: string | undefined;
  name?: string | undefined;
}): string {
  if (scheme.type === "http" && scheme.scheme !== undefined) {
    const header =
      scheme.scheme.toLowerCase() === "bearer"
        ? "Authorization: Bearer <token>"
        : `HTTP ${scheme.scheme}`;
    return scheme.bearerFormat === undefined ? header : `${header} (${scheme.bearerFormat})`;
  }
  if (scheme.type === "apiKey" && scheme.name !== undefined)
    return `API key in ${scheme.in ?? "header"} ${scheme.name}`;
  return scheme.type;
}

const METHOD_ORDER = new Map<string, number>(HTTP_METHODS.map((method, index) => [method, index]));

export function parseOpenApi(value: unknown): ApiReferenceModel | null {
  const parsed = DocumentSchema.safeParse(value);
  if (!parsed.success) return null;
  const document = parsed.data;
  const components = document.components;
  const defaultSecurity = securityNames(document.security);
  const groups = new Map<string, ApiGroup>();
  for (const tag of document.tags ?? [])
    groups.set(tag.name, { name: tag.name, description: text(tag.description), operations: [] });
  const usedIds = new Set<string>();

  for (const [path, item] of Object.entries(document.paths)) {
    const shared: unknown[] = Array.isArray(item.parameters) ? (item.parameters as unknown[]) : [];
    const methods = Object.keys(item)
      .filter((key) => METHOD_ORDER.has(key))
      .sort((a, b) => (METHOD_ORDER.get(a) ?? 0) - (METHOD_ORDER.get(b) ?? 0));
    for (const method of methods) {
      const operation = OperationSchema.safeParse(item[method]);
      if (!operation.success) continue;
      const data = operation.data;
      const parameters = [...shared, ...(data.parameters ?? [])].flatMap((raw) => {
        const parameter = ParameterSchema.safeParse(resolve(raw, components?.parameters));
        if (!parameter.success) return [];
        return [
          {
            name: parameter.data.name,
            in: parameter.data.in,
            required: parameter.data.required === true || parameter.data.in === "path",
            type: typeLabel(parameter.data.schema),
            description: text(parameter.data.description),
          },
        ];
      });
      let id = slugify(`${method} ${path}`.replace(/[^A-Za-z0-9]+/g, " "));
      while (usedIds.has(id)) id = `${id}-1`;
      usedIds.add(id);
      const entry: ApiOperation = {
        id,
        method: method.toUpperCase(),
        path,
        summary: text(data.summary),
        description: text(data.description),
        deprecated: data.deprecated === true,
        security: securityNames(data.security) ?? defaultSecurity,
        parameters,
        requestBody:
          data.requestBody === undefined
            ? null
            : {
                required: data.requestBody.required === true,
                description: text(data.requestBody.description),
                contents: contents(data.requestBody.content, components),
              },
        responses: Object.entries(data.responses ?? {}).map(([status, response]) => ({
          status,
          description: text(response.description),
          contents: contents(response.content, components),
        })),
      };
      const groupName = data.tags?.[0] ?? "Endpoints";
      const group = groups.get(groupName) ?? { name: groupName, description: null, operations: [] };
      group.operations.push(entry);
      groups.set(groupName, group);
    }
  }

  return {
    title: document.info.title,
    version: document.info.version,
    specVersion: document.openapi,
    description: text(document.info.description),
    servers: (document.servers ?? []).map((server) => ({
      url: server.url,
      description: text(server.description),
    })),
    security: Object.entries(components?.securitySchemes ?? {}).map(([name, scheme]) => ({
      name,
      summary: schemeSummary(scheme),
      description: text(scheme.description),
    })),
    groups: [...groups.values()].filter((group) => group.operations.length > 0),
    schemas: Object.entries(components?.schemas ?? {}).flatMap(([name, schema]) => {
      const view = schemaView(schema, components);
      return view === null
        ? []
        : [{ name, id: schemaId(name), view: { ...view, type: typeLabel(schema) } }];
    }),
  };
}
