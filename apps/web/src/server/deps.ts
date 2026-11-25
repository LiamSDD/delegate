import { after } from "next/server";

import { isFakeRunnerEnabled } from "@/flags";

import type { ApiDeps } from "./api";
import type { ConnectionsDeps } from "./connections-api";
import { defaultOpenEndpoint, loadMissionConnections } from "./connectors";
import { githubAppConfig } from "./github-connect";
import { getAppDatabase } from "./db";
import { createFakeRunner } from "./fake-runner";
import type { MissionRunner } from "./mission-runner";
import { runRegistry } from "./run-registry";
import { createRuntimeRunner, loadRepoPrompts } from "./runtime-runner";
import type { Execution } from "./runs";
import { secretBoxFromEnv } from "./secrets";
import { guestRunLimiter, networkRunLimiter, sessionSecret } from "./session";

export function selectRunner(env: Record<string, string | undefined>): {
  execution: Execution;
  run: MissionRunner;
} {
  if (isFakeRunnerEnabled(env)) return { execution: "simulated", run: createFakeRunner() };
  return { execution: "live", run: createRuntimeRunner({ env }) };
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
    connections: (app, session) => loadMissionConnections(app, session, connectorDeps(process.env)),
  };
}

export function connectorDeps(env: Record<string, string | undefined>) {
  return {
    production: env.NODE_ENV === "production",
    box: secretBoxFromEnv(env),
    open: defaultOpenEndpoint(),
    readerPrompt: loadRepoPrompts().reader.body,
  };
}

export function connectionsDeps(): ConnectionsDeps {
  return {
    api: apiDeps(),
    connectors: () => connectorDeps(process.env),
    github: () => githubAppConfig(process.env),
    fetch,
  };
}
