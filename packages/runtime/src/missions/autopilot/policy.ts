import { type ChildMissionId, type ChildStartedPayload } from "../../events";
import { type AutopilotTier } from "./schema";

export interface AutopilotChildPolicy {
  approvals: ChildStartedPayload["approvals"];
  connectors: boolean;
  githubInstallation: boolean;
  fixedPlan: boolean;
}

const SIDE_EFFECT_MISSIONS: ReadonlySet<ChildMissionId> = new Set(["ship-a-pr", "custom-goal"]);

export function autopilotChildPolicy(
  tier: AutopilotTier,
  missionId: ChildMissionId,
  workspaceAutoApprovesPlans: boolean,
): AutopilotChildPolicy {
  const fixedPlan = missionId === "ship-a-pr";
  const plan = fixedPlan || workspaceAutoApprovesPlans ? "auto" : "human";
  if (!SIDE_EFFECT_MISSIONS.has(missionId))
    return {
      approvals: { plan, sideEffects: "none" },
      connectors: false,
      githubInstallation: false,
      fixedPlan,
    };
  if (tier === "guest")
    return {
      approvals: { plan, sideEffects: missionId === "ship-a-pr" ? "patch_only" : "none" },
      connectors: false,
      githubInstallation: false,
      fixedPlan,
    };
  return {
    approvals: { plan, sideEffects: "ask" },
    connectors: missionId === "custom-goal",
    githubInstallation: missionId === "ship-a-pr",
    fixedPlan,
  };
}

export function describeChildPolicy(tier: AutopilotTier, policy: AutopilotChildPolicy): string {
  const plan =
    policy.approvals.plan === "auto"
      ? policy.fixedPlan
        ? "fixed plan, no plan approval"
        : "plan auto-approved by the workspace setting"
      : "plan waits for a human";
  const effects =
    policy.approvals.sideEffects === "patch_only"
      ? "demo visitor: patch only, no pull request"
      : policy.approvals.sideEffects === "ask"
        ? "side effects ask for approval unless pre-approved"
        : "read-only";
  return `${tier === "guest" ? "Demo visitor" : "Connected workspace"}: ${plan}; ${effects}.`;
}
