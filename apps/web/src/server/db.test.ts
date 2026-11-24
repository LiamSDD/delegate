import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { withTenant, workspaces } from "@delegate/db";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { connectionIdentity, createPgliteAppDatabase, findRepoRoot, resolveRepoRoot } from "./db";
import { createGuest, isLiveSession } from "./session";

const identityRow = z.object({ session_user: z.string(), current_user: z.string() });

describe("createPgliteAppDatabase", () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "delegate-pglite-"));
  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("serves app traffic as the non-owner login role, never as superuser", async () => {
    const app = await createPgliteAppDatabase({ dataRoot });
    try {
      const identity = await connectionIdentity(app.db);
      expect(identity).toEqual({ sessionUser: "delegate_app_login", bypassesRls: false });
      const inTenant = await withTenant(
        app.db,
        "5d1f6a0e-8b8f-4f53-9a43-3f0f1d2b7c11",
        async (tx) =>
          identityRow.parse(
            z
              .object({ rows: z.array(z.unknown()) })
              .parse(await tx.execute(sql`select session_user, current_user`)).rows[0],
          ),
      );
      expect(inTenant).toEqual({
        session_user: "delegate_app_login",
        current_user: "delegate_app",
      });
    } finally {
      await app.close();
    }
  });

  it("creates guests through the app login with no provisioning connection", async () => {
    const app = await createPgliteAppDatabase({ dataRoot });
    try {
      expect("provision" in app).toBe(false);
      const created = await createGuest(app);
      expect(created.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect((await connectionIdentity(app.db)).sessionUser).toBe("delegate_app_login");
      const visible = await withTenant(app.db, created.userId, (tx) =>
        tx.select({ id: workspaces.id }).from(workspaces),
      );
      expect(visible).toEqual([{ id: created.workspaceId }]);
    } finally {
      await app.close();
    }
  });

  it("persists across reopen and writes a .gitignore into the data directory", async () => {
    const first = await createPgliteAppDatabase({ dataRoot });
    const guest = await createGuest(first);
    await first.close();
    const second = await createPgliteAppDatabase({ dataRoot });
    try {
      expect(await isLiveSession(second, guest)).toBe(true);
    } finally {
      await second.close();
    }
    expect(readFileSync(path.join(dataRoot, ".gitignore"), "utf8")).toBe("*\n");
  });
});

describe("findRepoRoot", () => {
  it("walks up to the pnpm workspace root", () => {
    const root = findRepoRoot(import.meta.dirname);
    expect(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")).toContain("packages:");
  });

  it("finds the root even when the server is started from an unrelated directory", () => {
    const root = resolveRepoRoot([undefined, "/", import.meta.dirname]);
    expect(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")).toContain("packages:");
  });

  it("explains how to fix it when no candidate contains the workspace", () => {
    expect(() => resolveRepoRoot(["/"])).toThrow(/DELEGATE_REPO_ROOT/);
  });
});
