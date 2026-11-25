import { type ModelRole } from "../events";
import { type ChainEntry } from "../models";
import { type RunContext } from "./context";

export const ASSUMED_CALL_MS = 10_000;

export function chainHead(ctx: RunContext, role: ModelRole): ChainEntry | undefined {
  return ctx.router.chain(role, { classification: ctx.classification, latency: "interactive" })[0];
}

export function projectedCallMs(ctx: RunContext, role: ModelRole): number {
  const rpm = chainHead(ctx, role)?.provider.limits?.requestsPerMinute;
  return Math.max(ASSUMED_CALL_MS, rpm === undefined ? 0 : 60_000 / rpm);
}

export interface MissionClock {
  targetMs: number;
  startedAt: () => number;
  restart: () => void;
  elapsed: () => number;
  fits: (calls: readonly ModelRole[]) => boolean;
}

export function missionClock(ctx: RunContext, targetMs: number): MissionClock {
  let startedAt = ctx.now().getTime();
  const elapsed = () => ctx.now().getTime() - startedAt;
  return {
    targetMs,
    startedAt: () => startedAt,
    restart: () => {
      startedAt = ctx.now().getTime();
    },
    elapsed,
    fits: (calls) =>
      elapsed() + calls.reduce((sum, role) => sum + projectedCallMs(ctx, role), 0) <= targetMs,
  };
}
