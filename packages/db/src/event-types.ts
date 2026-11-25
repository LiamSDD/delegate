export const RUN_EVENT_TYPES = [
  "run.created",
  "plan.proposed",
  "plan.approved",
  "plan.revised",
  "step.started",
  "agent.spawned",
  "agent.message",
  "tool.called",
  "tool.result",
  "policy.decided",
  "artifact.created",
  "artifact.updated",
  "critic.flagged",
  "approval.requested",
  "approval.resolved",
  "usage.updated",
  "step.completed",
  "run.completed",
  "run.failed",
  "model.fallback",
  "connector.call",
  "sandbox.command",
  "ship.approval.requested",
  "ship.approval.decided",
  "pr.opened",
  "playbook.applied",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export function isRunEventType(value: string): value is RunEventType {
  return (RUN_EVENT_TYPES as readonly string[]).includes(value);
}
