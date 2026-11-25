import { z } from "zod";

import type { AutopilotMissionId, RunnableMissionId } from "@/lib/m2-contract";

const createdSchema = z.object({ runId: z.uuid() });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; code: string; message: string; retryAfterSeconds: number | null };

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface StartRunRequest {
  missionId: RunnableMissionId | AutopilotMissionId;
  input: {
    url?: string;
    focus?: string;
    department?: string;
    goal?: string;
    name?: string;
    opportunityId?: string;
    ref?: string;
  };
  parentRunId?: string;
}

export function startCompanyXray(
  input: { url: string; focus?: string },
  fetcher: Fetcher = (path, init) => fetch(path, init),
): Promise<StartRunResult> {
  return startRun({ missionId: "company-xray", input }, fetcher);
}

export async function startRun(
  request: StartRunRequest,
  fetcher: Fetcher = (path, init) => fetch(path, init),
): Promise<StartRunResult> {
  let response: Response;
  try {
    response = await fetcher("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
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
