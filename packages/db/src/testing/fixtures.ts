import {
  approvals,
  artifacts,
  auditLog,
  chunks,
  documents,
  members,
  memories,
  orgs,
  policies,
  runEvents,
  runs,
  users,
  workspaces,
} from "../schema";
import type { MemberRoleName } from "../schema/rls";
import type { TestDb } from "./pglite";

async function one<T>(rows: Promise<T[]>): Promise<T> {
  const [row] = await rows;
  if (!row) {
    throw new Error("fixture insert returned no row");
  }
  return row;
}

export async function seedUser(db: TestDb, displayName: string) {
  return one(
    db
      .insert(users)
      .values({ displayName, email: `${displayName}@example.test` })
      .returning(),
  );
}

export async function seedMember(
  db: TestDb,
  workspaceId: string,
  userId: string,
  role: MemberRoleName,
) {
  return one(db.insert(members).values({ workspaceId, userId, role }).returning());
}

export async function seedWorkspaceContent(db: TestDb, label: string, createdBy: string) {
  const org = await one(
    db
      .insert(orgs)
      .values({ name: `Org ${label}`, slug: `org-${label}` })
      .returning(),
  );
  const workspace = await one(
    db
      .insert(workspaces)
      .values({ orgId: org.id, name: `Workspace ${label}`, slug: `ws-${label}` })
      .returning(),
  );
  const run = await one(
    db
      .insert(runs)
      .values({ workspaceId: workspace.id, mission: "xray", input: { label }, createdBy })
      .returning(),
  );
  await db
    .insert(runEvents)
    .values({ runId: run.id, workspaceId: workspace.id, seq: 1, type: "run.created" });
  await db.insert(artifacts).values({
    runId: run.id,
    workspaceId: workspace.id,
    kind: "report",
    title: `Report ${label}`,
    content: { label },
  });
  const approval = await one(
    db
      .insert(approvals)
      .values({
        runId: run.id,
        workspaceId: workspace.id,
        stepId: "step-1",
        action: { tool: "noop" },
      })
      .returning(),
  );
  const policy = await one(
    db
      .insert(policies)
      .values({ workspaceId: workspace.id, name: "default", definition: { rules: [] } })
      .returning(),
  );
  await db.insert(auditLog).values({
    workspaceId: workspace.id,
    actorType: "system",
    action: "seed",
    decision: "n/a",
    policyId: policy.id,
    approvalId: approval.id,
  });
  await db.insert(memories).values({
    workspaceId: workspace.id,
    key: "fact",
    value: { label },
    createdByAgent: "researcher",
  });
  const document = await one(
    db
      .insert(documents)
      .values({ workspaceId: workspace.id, title: `Doc ${label}`, contentHash: `hash-${label}` })
      .returning(),
  );
  await db.insert(chunks).values({
    documentId: document.id,
    workspaceId: workspace.id,
    ordinal: 0,
    text: `Chunk for workspace ${label}`,
  });
  return { org, workspace, run, approval, policy, document };
}
