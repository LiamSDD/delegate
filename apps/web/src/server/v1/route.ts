import type { OperationId } from "@delegate/sdk/contract";

import { v1Deps } from "./deps";
import type { AuthenticatedOperationId } from "./handlers";
import { handleOpenApi, handleUnknownRoute, handleV1 } from "./router";

export interface V1RouteContext {
  params: Promise<Record<string, string | string[] | undefined>>;
}

export interface V1RouteHandler {
  (request: Request, context: V1RouteContext): Promise<Response>;
  readonly operationId: OperationId;
}

function pathParams(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw).flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value]] : [],
    ),
  );
}

export function v1Route(id: AuthenticatedOperationId): V1RouteHandler {
  return Object.assign(
    async (request: Request, context: V1RouteContext) =>
      handleV1(id, request, pathParams(await context.params), v1Deps()),
    { operationId: id },
  );
}

export function v1OpenApiRoute(): V1RouteHandler {
  return Object.assign(() => Promise.resolve(handleOpenApi()), {
    operationId: "getOpenApi" as const,
  });
}

export function v1UnknownRoute(): (request: Request) => Promise<Response> {
  return (request) => Promise.resolve(handleUnknownRoute(request));
}
