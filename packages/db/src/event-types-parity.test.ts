import { RUN_EVENT_TYPES as RUNTIME_EVENT_TYPES } from "@delegate/runtime";
import { describe, expect, it } from "vitest";

import { RUN_EVENT_TYPES } from "./event-types";

describe("run event types", () => {
  it("match the runtime union exactly, so the database CHECK accepts every event the runtime emits", () => {
    expect([...RUN_EVENT_TYPES].sort()).toEqual([...RUNTIME_EVENT_TYPES].sort());
  });
});
