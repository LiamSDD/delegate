import type { ShipImprovement } from "@delegate/runtime";
import { z } from "zod";

import type { StartRunResult } from "./start-run";

const createdSchema = z.object({ runId: z.uuid() });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface StartShipRequest {
  repoUrl: string;
  ref?: string | undefined;
  improvement: ShipImprovement;
  parentRunId?: string | undefined;
}

export async function startShip(
  request: StartShipRequest,
  fetcher: Fetcher = (path, init) => fetch(path, init),
): Promise<StartRunResult> {
  let response: Response;
  try {
    response = await fetcher("/api/ship", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoUrl: request.repoUrl,
        improvement: request.improvement,
        ...(request.ref === undefined || request.ref === "" ? {} : { ref: request.ref }),
        ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
      }),
    });
  } catch {
    return {
      ok: false,
      code: "network",
      message: "Could not reach Delegate. Check your connection and try again.",
      retryAfterSeconds: null,
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 201) {
    const created = createdSchema.safeParse(body);
    if (created.success) return { ok: true, runId: created.data.runId };
  }
  const failure = errorSchema.safeParse(body);
  const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return {
    ok: false,
    code: failure.success ? failure.data.error.code : "unexpected",
    message: failure.success
      ? failure.data.error.message
      : `The server answered with an unexpected response (HTTP ${response.status}).`,
    retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
  };
}
