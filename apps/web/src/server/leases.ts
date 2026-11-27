import { randomUUID } from "node:crypto";

import { runs, withTenant } from "@delegate/db";
import type { RunLease } from "@delegate/runtime/server";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { LEASE_TTL_MS } from "@/lib/runs/resume";

import type { AppDatabase } from "./db";
import type { RunContext } from "./runs";

const holder = globalThis as typeof globalThis & { __delegateWorkerId?: string };

export function workerId(): string {
  holder.__delegateWorkerId ??= `web-${process.pid}-${randomUUID().slice(0, 8)}`;
  return holder.__delegateWorkerId;
}

export function createDbLease(
  app: AppDatabase,
  ctx: RunContext,
  owner = `${workerId()}:${randomUUID().slice(0, 8)}`,
  ttlMs = LEASE_TTL_MS,
): RunLease {
  const claim = async (takeOver: boolean) => {
    const expires = sql`now() + ${`${String(ttlMs)} milliseconds`}::interval`;
    const rows = await withTenant(app.db, ctx.userId, (tx) =>
      tx
        .update(runs)
        .set({ leaseOwner: owner, leaseExpiresAt: expires })
        .where(
          and(
            eq(runs.id, ctx.runId),
            takeOver
              ? or(
                  isNull(runs.leaseOwner),
                  eq(runs.leaseOwner, owner),
                  lt(runs.leaseExpiresAt, sql`now()`),
                )
              : eq(runs.leaseOwner, owner),
          ),
        )
        .returning({ id: runs.id }),
    );
    return rows.length === 1;
  };
  return {
    ttlMs,
    acquire: () => claim(true),
    renew: () => claim(false),
    release: async () => {
      await withTenant(app.db, ctx.userId, (tx) =>
        tx
          .update(runs)
          .set({ leaseOwner: null, leaseExpiresAt: null })
          .where(and(eq(runs.id, ctx.runId), eq(runs.leaseOwner, owner))),
      );
    },
  };
}
