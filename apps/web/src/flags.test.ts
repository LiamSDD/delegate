import { describe, expect, it } from "vitest";

import { isFakeRunnerEnabled, isOwnerModeEnabled, isShipAPrEnabled } from "./flags";

describe("isShipAPrEnabled", () => {
  it("is off unless DELEGATE_SHIP_A_PR=1, so the sandbox quota is never spent by default", () => {
    expect(isShipAPrEnabled({ DELEGATE_SHIP_A_PR: "1" })).toBe(true);
    expect(isShipAPrEnabled({ DELEGATE_SHIP_A_PR: "true" })).toBe(false);
    expect(isShipAPrEnabled({})).toBe(false);
  });
});

describe("isFakeRunnerEnabled", () => {
  it("is on only when explicitly requested outside production", () => {
    expect(isFakeRunnerEnabled({ DELEGATE_FAKE_RUNNER: "1", NODE_ENV: "development" })).toBe(true);
    expect(isFakeRunnerEnabled({ DELEGATE_FAKE_RUNNER: "1", NODE_ENV: "production" })).toBe(false);
    expect(isFakeRunnerEnabled({ DELEGATE_FAKE_RUNNER: "true", NODE_ENV: "development" })).toBe(
      false,
    );
    expect(isFakeRunnerEnabled({ NODE_ENV: "development" })).toBe(false);
  });
});

describe("isOwnerModeEnabled", () => {
  it("is on only for DELEGATE_OWNER_MODE=1 outside production", () => {
    expect(isOwnerModeEnabled({ DELEGATE_OWNER_MODE: "1", NODE_ENV: "development" })).toBe(true);
    expect(isOwnerModeEnabled({ DELEGATE_OWNER_MODE: "1", NODE_ENV: "production" })).toBe(false);
    expect(isOwnerModeEnabled({ DELEGATE_OWNER_MODE: "true", NODE_ENV: "development" })).toBe(
      false,
    );
    expect(isOwnerModeEnabled({ NODE_ENV: "development" })).toBe(false);
  });
});
