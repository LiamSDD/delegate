import { MODEL_ROLES, type RunEventDraft } from "../events";

export const OFFLINE_TEST_MODEL = "offline-max";

interface RoleChains {
  roles: Record<string, { provider: string }[]>;
}

export function withOfflineHead(config: unknown, provider = "pollinations"): unknown {
  const base = config as RoleChains;
  return {
    ...base,
    roles: Object.fromEntries(
      MODEL_ROLES.map((role) => {
        const chain = base.roles[role] ?? [];
        const after = chain.findIndex((entry) => entry.provider === provider) + 1;
        return [
          role,
          [
            ...chain.slice(0, after),
            {
              provider,
              model: OFFLINE_TEST_MODEL,
              displayName: "Offline Max",
              contextWindow: 131_072,
              supportsTools: true,
              interactive: false,
            },
            ...chain.slice(after),
          ],
        ];
      }),
    ),
  };
}

export function maxQualityRun(config: unknown) {
  return {
    context: { audience: "owner" as const, classification: "public" as const },
    quality: "max" as const,
    modelsConfig: withOfflineHead(config),
  };
}

export function stepsServedOffline(events: readonly RunEventDraft[]): string[] {
  const steps = new Set<string>();
  for (const event of events)
    if (event.type === "usage.updated" && event.payload.model === OFFLINE_TEST_MODEL)
      steps.add(event.stepId ?? "(no step)");
  return [...steps].sort();
}

export function maxQualityNotes(events: readonly RunEventDraft[]): string[] {
  return events.flatMap((event) =>
    event.type === "agent.message" && event.payload.text.startsWith("Waiting for Offline Max")
      ? [event.stepId]
      : [],
  );
}
