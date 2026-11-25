import { type AuditListing, listPolicyDecisions } from "../audit";
import type { AppDatabase } from "../db";
import type { GuestSession } from "../session";
import { readRunsPaused } from "../workspace-settings";
import { type ActiveRuns, listActiveRuns } from "./active-runs";
import { type ApprovalsInbox, listPendingApprovals } from "./inbox";
import { recentSwitchActivity, type SwitchActivity } from "./switches";
import { emptyUsage, type WorkspaceUsage, workspaceUsage } from "./usage";

export const RECENT_DECISIONS = 8;
export const CONTROL_REFRESH_MS = 10_000;

export interface MissionControl {
  renderedAt: Date;
  hasWorkspace: boolean;
  runsPausedAt: Date | null;
  active: ActiveRuns;
  inbox: ApprovalsInbox;
  usage: WorkspaceUsage;
  switchActivity: SwitchActivity[];
  decisions: AuditListing;
}

export function emptyMissionControl(now = new Date()): MissionControl {
  return {
    renderedAt: now,
    hasWorkspace: false,
    runsPausedAt: null,
    active: { runs: [], truncated: false },
    inbox: { items: [], truncated: false },
    usage: emptyUsage(now),
    switchActivity: [],
    decisions: { entries: [], counts: { allow: 0, deny: 0, require_approval: 0 } },
  };
}

export async function missionControl(
  app: AppDatabase,
  session: GuestSession,
  now = new Date(),
): Promise<MissionControl> {
  const [runsPausedAt, active, inbox, usage, switchActivity, decisions] = await Promise.all([
    readRunsPaused(app, session),
    listActiveRuns(app, session, now),
    listPendingApprovals(app, session, now),
    workspaceUsage(app, session, now),
    recentSwitchActivity(app, session),
    listPolicyDecisions(app, session, { limit: RECENT_DECISIONS }),
  ]);
  return {
    renderedAt: now,
    hasWorkspace: true,
    runsPausedAt,
    active,
    inbox,
    usage,
    switchActivity,
    decisions,
  };
}
