import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_RETRIES, DEFAULT_WAIT_TIMEOUT_MS } from "./client";
import { API_ERROR_CODES, API_ERROR_STATUS } from "./contract/errors";
import { OPERATIONS } from "./contract/operations";
import {
  API_BASE_PATH,
  IDEMPOTENCY_KEY_MAX_CHARS,
  IDEMPOTENCY_TTL_SECONDS,
  MISSION_IDS,
  MISSION_INPUT_RULES,
  RATE_LIMIT_HEADERS,
  RUN_STATUSES,
  SSE_CONTROL_EVENTS,
} from "./contract/schemas";

const guide = readFileSync(
  fileURLToPath(new URL("../../../docs/guides/api.md", import.meta.url)),
  "utf8",
);

function tableRow(firstCell: string): string[] | null {
  const line = guide.split("\n").find((candidate) => candidate.startsWith(`| \`${firstCell}\` |`));
  return line === undefined ? null : line.split("|").map((cell) => cell.trim());
}

describe("docs/guides/api.md", () => {
  it("lists every error code with its status", () => {
    for (const code of API_ERROR_CODES)
      expect(tableRow(code)?.[2], code).toBe(String(API_ERROR_STATUS[code]));
  });

  it("lists every operation, and no operation the contract does not have", () => {
    const documented = [...guide.matchAll(/^\| `(GET|POST) (\/api\/v1[^`]*)` \|/gm)].map(
      (match) => `${match[1] ?? ""} ${match[2] ?? ""}`,
    );
    const contract = Object.values(OPERATIONS).map(
      (spec) => `${spec.method} ${API_BASE_PATH}${spec.path}`,
    );
    expect(documented.sort()).toEqual(contract.sort());
  });

  it("lists every mission with the input it needs", () => {
    for (const id of MISSION_IDS) {
      const row = tableRow(id);
      expect(row, id).not.toBeNull();
      for (const field of MISSION_INPUT_RULES[id].required)
        expect(row?.[2], `${id} needs ${field}`).toContain(`\`${field}\``);
      for (const field of MISSION_INPUT_RULES[id].optional)
        expect(row?.[3], `${id} takes ${field}`).toContain(`\`${field}\``);
    }
  });

  it("states the limits and names the contract defines", () => {
    for (const status of RUN_STATUSES) expect(guide).toContain(`\`${status}\``);
    for (const header of Object.values(RATE_LIMIT_HEADERS)) expect(guide).toContain(header);
    for (const event of SSE_CONTROL_EVENTS) expect(guide).toContain(`\`${event}\``);
    expect(guide).toContain(`up to ${IDEMPOTENCY_KEY_MAX_CHARS} printable ASCII characters`);
    expect(guide).toContain(`remembered for ${IDEMPOTENCY_TTL_SECONDS / 3600} hours`);
    expect(DEFAULT_MAX_RETRIES).toBe(2);
    expect(guide).toContain("retried twice");
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(600_000);
    expect(guide).toContain("the default is ten minutes");
  });
});
