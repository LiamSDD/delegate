import { pgEnum } from "drizzle-orm/pg-core";

export const userKind = pgEnum("user_kind", ["member", "guest", "agent"]);

export const memberRole = pgEnum("member_role", ["owner", "admin", "operator", "viewer"]);

export const runStatus = pgEnum("run_status", [
  "pending",
  "planning",
  "awaiting_approval",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

export const auditActorType = pgEnum("audit_actor_type", ["user", "agent", "system"]);

export const auditDecision = pgEnum("audit_decision", ["allow", "deny", "require_approval", "n/a"]);

export const documentClassification = pgEnum("document_classification", [
  "public",
  "internal",
  "confidential",
]);
