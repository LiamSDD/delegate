import { createDbPlaybookStore } from "@delegate/db";
import type { PlaybookStore } from "@delegate/runtime";
import { after } from "next/server";

import { isFakeRunnerEnabled, isShipAPrEnabled } from "@/flags";

import type { ApiDeps } from "./api";
import { getAppDatabase } from "./db";
import { createFakeRunner } from "./fake-runner";
import type { MissionRunner } from "./mission-runner";
import { runRegistry } from "./run-registry";
import { createRuntimeRunner } from "./runtime-runner";
import type { Execution } from "./runs";
import { guestRunLimiter, networkRunLimiter, sessionSecret } from "./session";

export function selectRunner(env: Record<string, string | undefined>): {
  execution: Execution;
  run: MissionRunner;
} {
  if (isFakeRunnerEnabled(env)) return { execution: "simulated", run: createFakeRunner() };
  return { execution: "live", run: createRuntimeRunner({ env, playbooks: dbPlaybooks }) };
}

export function dbPlaybooks(scope: { workspaceId: string; userId: string }): PlaybookStore {
  const store = () => getAppDatabase().then((app) => createDbPlaybookStore(app.db, scope));
  return {
    read: (key) => store().then((playbooks) => playbooks.read(key)),
    record: (run, options) => store().then((playbooks) => playbooks.record(run, options)),
  };
}

export function apiDeps(): ApiDeps {
  return {
    app: getAppDatabase,
    secret: sessionSecret,
    guestLimiter: guestRunLimiter(),
    ipLimiter: networkRunLimiter(),
    registry: runRegistry(),
    runner: () => selectRunner(process.env),
    schedule: (task) => {
      after(task);
    },
    production: process.env.NODE_ENV === "production",
    shipEnabled: isShipAPrEnabled(process.env),
  };
}
