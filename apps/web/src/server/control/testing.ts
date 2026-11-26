import type { ApiDeps } from "../api";
import type { AppDatabase } from "../db";
import { createFakeRunner } from "../fake-runner";
import { createRunRegistry } from "../run-registry";
import { createRunRecord, type Execution, type RunContext } from "../runs";
import { createRateLimiter, type GuestSession, resolveGuest, signSession } from "../session";

export const ORIGIN = "http://localhost:3000";
export const HOST = "localhost:3000";
export const SECRET = "s".repeat(32);

export type TestDeps = ApiDeps & { tasks: (() => Promise<void>)[] };

export function testDeps(app: AppDatabase, overrides: Partial<ApiDeps> = {}): TestDeps {
  const tasks: (() => Promise<void>)[] = [];
  return {
    app: () => Promise.resolve(app),
    secret: () => SECRET,
    guestLimiter: createRateLimiter({ limit: 50, windowMs: 3_600_000 }),
    ipLimiter: createRateLimiter({ limit: 500, windowMs: 3_600_000 }),
    registry: createRunRegistry(),
    runner: () => ({ execution: "simulated", run: createFakeRunner({ delayMs: 0 }) }),
    schedule: (task) => {
      tasks.push(task);
    },
    production: false,
    tasks,
    ...overrides,
  };
}

export interface TestGuest {
  session: GuestSession;
  cookie: string;
}

export async function newGuest(app: AppDatabase): Promise<TestGuest> {
  const { session } = await resolveGuest(app, undefined, SECRET);
  return { session, cookie: `delegate_session=${signSession(session, SECRET)}` };
}

export async function newRun(
  app: AppDatabase,
  guest: TestGuest,
  options: {
    missionId?: string;
    input?: Record<string, unknown>;
    execution?: Execution;
    parentRunId?: string;
  } = {},
): Promise<RunContext> {
  const { runId } = await createRunRecord(app, guest.session, {
    missionId: options.missionId ?? "company-xray",
    input: options.input ?? { url: "https://acme.example/" },
    execution: options.execution ?? "live",
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
  });
  return { runId, workspaceId: guest.session.workspaceId, userId: guest.session.userId };
}

export function jsonPost(
  path: string,
  cookie: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: HOST,
      ...(cookie === null ? {} : { cookie }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

const STATEMENT_BUILDERS = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "insert",
  "update",
  "delete",
  "execute",
]);

type Callable = (...args: unknown[]) => unknown;

export function countingApp(app: AppDatabase): { app: AppDatabase; statements: () => number } {
  let statements = 0;
  const counted = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        const value: unknown = Reflect.get(inner, property, receiver);
        if (typeof value !== "function") return value;
        const call = value as Callable;
        if (property === "transaction")
          return (run: (tx: object) => unknown) =>
            call.call(inner, (tx: object) => run(counted(tx)));
        if (typeof property === "string" && STATEMENT_BUILDERS.has(property))
          return (...args: unknown[]) => {
            statements += 1;
            return call.apply(inner, args);
          };
        return call.bind(inner);
      },
    });
  return { app: { ...app, db: counted(app.db) }, statements: () => statements };
}
