import { readFileSync } from "node:fs";

import { parseLearnedRouting, type LearnedRouting } from "./learned";

export const LEARNED_ROUTING_FILE = "config/routing.learned.json";
const REPO_ROOT_FROM_HERE = "../../../../";

export type RoutingLog = (message: string) => void;

export interface LearnedRoutingSource {
  read?: () => string | undefined;
  log?: RoutingLog;
}

const logged = new Set<string>();

export function resetLearnedRoutingLog(): void {
  logged.clear();
}

function logOnce(log: RoutingLog, message: string): void {
  if (logged.has(message)) return;
  logged.add(message);
  log(message);
}

function readRepoFile(relative: string): string | undefined {
  try {
    return readFileSync(new URL(relative, import.meta.url), "utf8");
  } catch {
    return undefined;
  }
}

function defaultLog(message: string): void {
  console.warn(message);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function checkLearnedRouting(
  input: unknown,
  log: RoutingLog = defaultLog,
): LearnedRouting | undefined {
  const parsed = parseLearnedRouting(input);
  if (parsed.ok) return parsed.routing;
  logOnce(
    log,
    `Learned routing ignored: ${LEARNED_ROUTING_FILE} is invalid (${parsed.reason}). Models keep their configured order.`,
  );
  return undefined;
}

export function loadLearnedRouting(source: LearnedRoutingSource = {}): LearnedRouting | undefined {
  const log = source.log ?? defaultLog;
  const text =
    source.read === undefined
      ? readRepoFile(`${REPO_ROOT_FROM_HERE}${LEARNED_ROUTING_FILE}`)
      : source.read();
  if (text === undefined) {
    logOnce(
      log,
      `Learned routing off: ${LEARNED_ROUTING_FILE} is absent. Models keep their configured order.`,
    );
    return undefined;
  }
  const json = parseJson(text);
  if (!json.ok) {
    logOnce(
      log,
      `Learned routing ignored: ${LEARNED_ROUTING_FILE} is not valid JSON. Models keep their configured order.`,
    );
    return undefined;
  }
  return checkLearnedRouting(json.value, log);
}
