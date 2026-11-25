import type { z } from "zod";

import { type ApiDeps, apiError, guestFor, isSameOrigin } from "../api";
import { hasBearer } from "../api-tokens";
import type { AppDatabase } from "../db";
import type { GuestSession } from "../session";

export interface Operator {
  app: AppDatabase;
  session: GuestSession;
}

export function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

export function guardWebMutation(request: Request, action: string): Response | null {
  if (hasBearer(request))
    return apiError(403, "forbidden", "This can only be done from the Delegate web app.");
  if (!isSameOrigin(request))
    return apiError(403, "forbidden_origin", `Cross-origin requests cannot ${action}.`);
  return null;
}

export async function operatorFor(
  request: Request,
  deps: ApiDeps,
  action: string,
): Promise<Operator | Response> {
  const refused = guardWebMutation(request, action);
  if (refused !== null) return refused;
  const guest = await guestFor(request, deps);
  return guest ?? apiError(404, "not_found", "No workspace is visible to this session.");
}

export function postgresCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return null;
}
