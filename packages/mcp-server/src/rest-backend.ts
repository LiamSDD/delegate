import { type DelegateClient, DelegateApiError } from "@delegate/sdk";

import { type DelegateBackend } from "./server";

export const STDIO_MISSIONS = [
  {
    id: "company-xray",
    title: "Company X-ray",
    description: "A cited brief on a company from its public footprint.",
  },
  {
    id: "automation-audit",
    title: "AI Automation Audit",
    description: "Ranked workflows AI agents could automate, with an explicit ROI model.",
  },
  {
    id: "build-agent",
    title: "Build-an-Agent",
    description: "An assistant trained on the company's public website.",
  },
] as const;

function nullOn404<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((error: unknown) => {
    if (error instanceof DelegateApiError && error.status === 404) return null;
    throw error;
  });
}

export function restBackend(client: DelegateClient): DelegateBackend {
  return {
    startMission: (request) => client.startRun(request),
    getRun: (runId) => nullOn404(client.getRun(runId)),
    listRuns: (limit) => client.listRuns(limit),
    decidePlan: (runId, decision) => client.decidePlan(runId, decision),
    getArtifact: (runId, artifactId) => nullOn404(client.getArtifact(runId, artifactId)),
    runUrl: (runId) => client.runUrl(runId),
  };
}
