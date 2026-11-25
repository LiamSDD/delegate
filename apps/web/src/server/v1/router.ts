import {
  buildOpenApiDocument,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  OPERATIONS,
  type OperationSpec,
  REQUEST_ID_HEADER,
} from "@delegate/sdk/contract";
import type { z } from "zod";

import { authenticateBearer } from "../api-tokens";
import { siteOrigin } from "../mcp-endpoint";
import { flushSoon } from "../webhooks/dispatch";
import { errorResponse, newRequestId, NO_STORE, V1Error, zodIssues } from "./errors";
import {
  type AuthenticatedOperationId,
  HANDLERS,
  type V1Context,
  type V1Deps,
  type V1Result,
} from "./handlers";
import { idempotencyKeyOf, type JsonReply, requestFingerprint, runIdempotent } from "./idempotency";
import { rateLimitHeaders } from "./rate-limit";

const EVENT_STREAM = "text/event-stream";

function parsed<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new V1Error("invalid_request", `The ${what} does not match the v1 contract.`, {
    issues: zodIssues(result.error),
  });
}

function queryRecord(url: URL): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in record)
      throw new V1Error("invalid_request", "The query does not match the v1 contract.", {
        issues: [`${key}: given more than once`],
      });
    record[key] = value;
  }
  return record;
}

async function readBody(request: Request, spec: OperationSpec): Promise<string> {
  if (spec.body === undefined) return "";
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > spec.maxBodyBytes)
    throw new V1Error("payload_too_large", "The request body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > spec.maxBodyBytes)
    throw new V1Error("payload_too_large", "The request body is too large.");
  return text;
}

function parseBody(request: Request, spec: OperationSpec, text: string): unknown {
  if (spec.body === undefined) return undefined;
  if (text.trim() === "") {
    if (spec.bodyRequired)
      throw new V1Error("invalid_request", "This operation needs a JSON body.");
    return parsed(spec.body, {}, "body");
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    throw new V1Error("unsupported_media_type", "Send the request body as application/json.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new V1Error("invalid_json", "The request body is not valid JSON.");
  }
  return parsed(spec.body, json, "body");
}

function wantsEventStream(request: Request, spec: OperationSpec): boolean {
  return (
    spec.eventStream !== null &&
    (request.headers.get("accept") ?? "").toLowerCase().includes(EVENT_STREAM)
  );
}

function jsonResponse(reply: JsonReply, headers: Record<string, string>): Response {
  return new Response(reply.body, {
    status: reply.status,
    headers: {
      "Content-Type": "application/json",
      ...NO_STORE,
      ...reply.headers,
      ...headers,
    },
  });
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

function logFailure(requestId: string, operation: string, error: unknown): void {
  const detail =
    error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "unknown error";
  console.error("v1 request failed", requestId, operation, detail);
}

async function serialise<Id extends AuthenticatedOperationId>(
  id: Id,
  result: V1Result<Id>,
): Promise<JsonReply | Response> {
  if ("stream" in result) return result.stream;
  const spec: OperationSpec = OPERATIONS[id];
  const body = await spec.response.safeParseAsync(result.body);
  if (!body.success)
    throw new Error(
      `the ${id} response does not match the v1 contract: ${zodIssues(body.error).slice(0, 5).join("; ")}`,
    );
  return {
    status: spec.status,
    body: JSON.stringify(body.data),
    headers: result.headers ?? {},
  };
}

export async function handleV1<Id extends AuthenticatedOperationId>(
  id: Id,
  request: Request,
  rawParams: Record<string, string> | undefined,
  deps: V1Deps,
): Promise<Response> {
  const requestId = newRequestId();
  const spec: OperationSpec = OPERATIONS[id];
  let headers: Record<string, string> = { [REQUEST_ID_HEADER]: requestId };
  try {
    const app = await deps.api.app();
    const session = await authenticateBearer(app, request);
    if (session === null)
      throw new V1Error("unauthorized", "The API token is missing, invalid or revoked.", {
        headers: { "WWW-Authenticate": 'Bearer realm="delegate"' },
      });
    const budget = deps.limiter.take(session.tokenId);
    headers = { ...headers, ...rateLimitHeaders(budget) };
    if (!budget.ok)
      throw new V1Error(
        "rate_limited",
        `This token made ${budget.limit} requests in the current window. Try again in ${budget.resetSeconds} seconds.`,
        { headers: { "Retry-After": String(budget.resetSeconds) } },
      );
    flushSoon(app, session);
    const url = new URL(request.url);
    const stream = wantsEventStream(request, spec);
    const text = await readBody(request, spec);
    const context = {
      request,
      app,
      session,
      deps,
      origin: siteOrigin(request),
      wantsEventStream: stream,
      params: spec.params === undefined ? undefined : parsed(spec.params, rawParams, "path"),
      query: spec.query === undefined ? undefined : parsed(spec.query, queryRecord(url), "query"),
      body: parseBody(request, spec, text),
    } as V1Context<Id>;
    const execute = async () => serialise(id, await HANDLERS[id](context));
    const key = spec.idempotencyKey ? idempotencyKeyOf(request) : null;
    if (key === null) {
      const reply = await execute();
      return reply instanceof Response ? withHeaders(reply, headers) : jsonResponse(reply, headers);
    }
    if (stream)
      throw new V1Error(
        "invalid_request",
        `${IDEMPOTENCY_KEY_HEADER} cannot be combined with a streamed response.`,
      );
    const { reply, replayed } = await runIdempotent(
      app,
      session,
      { key, requestHash: requestFingerprint(spec.method, url.pathname, text) },
      async () => {
        const result = await execute();
        if (result instanceof Response) throw new Error(`${id} answered with a stream`);
        return result;
      },
    );
    return jsonResponse(
      reply,
      replayed ? { ...headers, [IDEMPOTENCY_REPLAYED_HEADER]: "true" } : headers,
    );
  } catch (error) {
    if (error instanceof V1Error) return errorResponse(requestId, error, headers);
    logFailure(requestId, id, error);
    return errorResponse(
      requestId,
      new V1Error("internal", "The request failed on the server. Quote the requestId."),
      headers,
    );
  }
}

export const OPENAPI_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400";

export function handleOpenApi(): Response {
  return Response.json(buildOpenApiDocument(), {
    headers: {
      "Cache-Control": OPENAPI_CACHE_CONTROL,
      [REQUEST_ID_HEADER]: newRequestId(),
    },
  });
}
