import { type SQL, sql } from "drizzle-orm";
import { type AnyPgColumn, type PgPolicy, pgPolicy, pgRole } from "drizzle-orm/pg-core";

export const appRole = pgRole("delegate_app").existing();

export const definerRole = pgRole("delegate_definer").existing();

export const currentUserId = sql`nullif(current_setting('app.user_id', true), '')::uuid`;

export type MemberRoleName = "owner" | "admin" | "operator" | "viewer";

export const readers: readonly MemberRoleName[] = ["owner", "admin", "operator", "viewer"];
export const operators: readonly MemberRoleName[] = ["owner", "admin", "operator"];
export const admins: readonly MemberRoleName[] = ["owner", "admin"];

export function hasWorkspaceRole(workspaceId: AnyPgColumn, roles: readonly MemberRoleName[]): SQL {
  const list = sql.raw(roles.map((role) => `'${role}'`).join(", "));
  return sql`app_workspace_role(${workspaceId}) in (${list})`;
}

type PolicyCommand = "select" | "insert" | "update" | "delete";

export function definerPolicies(table: string, commands: readonly PolicyCommand[]): PgPolicy[] {
  return commands.map((command) =>
    pgPolicy(`${table}_definer_${command}`, {
      for: command,
      to: definerRole,
      ...(command === "insert" ? {} : { using: sql`true` }),
      ...(command === "select" || command === "delete" ? {} : { withCheck: sql`true` }),
    }),
  );
}

export function tenantPolicies(
  table: string,
  workspaceId: AnyPgColumn,
  access: Partial<Record<PolicyCommand, readonly MemberRoleName[]>>,
  insertAlsoRequires?: SQL,
): PgPolicy[] {
  const policies: PgPolicy[] = [];
  if (access.select) {
    policies.push(
      pgPolicy(`${table}_select`, {
        for: "select",
        to: appRole,
        using: hasWorkspaceRole(workspaceId, access.select),
      }),
    );
  }
  if (access.insert) {
    policies.push(
      pgPolicy(`${table}_insert`, {
        for: "insert",
        to: appRole,
        withCheck:
          insertAlsoRequires === undefined
            ? hasWorkspaceRole(workspaceId, access.insert)
            : sql`${hasWorkspaceRole(workspaceId, access.insert)} and ${insertAlsoRequires}`,
      }),
    );
  }
  if (access.update) {
    policies.push(
      pgPolicy(`${table}_update`, {
        for: "update",
        to: appRole,
        using: hasWorkspaceRole(workspaceId, access.update),
        withCheck: hasWorkspaceRole(workspaceId, access.update),
      }),
    );
  }
  if (access.delete) {
    policies.push(
      pgPolicy(`${table}_delete`, {
        for: "delete",
        to: appRole,
        using: hasWorkspaceRole(workspaceId, access.delete),
      }),
    );
  }
  return policies;
}
