export interface FlagEnv {
  NODE_ENV?: string | undefined;
  DELEGATE_FAKE_RUNNER?: string | undefined;
}

export function isFakeRunnerEnabled(env: FlagEnv): boolean {
  return env.DELEGATE_FAKE_RUNNER === "1" && env.NODE_ENV !== "production";
}

export interface OwnerModeEnv {
  NODE_ENV?: string | undefined;
  DELEGATE_OWNER_MODE?: string | undefined;
}

export function isOwnerModeEnabled(env: OwnerModeEnv): boolean {
  return env.DELEGATE_OWNER_MODE === "1" && env.NODE_ENV !== "production";
}

export interface ShipEnv {
  NODE_ENV?: string | undefined;
  DELEGATE_SHIP_A_PR?: string | undefined;
}

export function isShipAPrEnabled(env: ShipEnv): boolean {
  return env.DELEGATE_SHIP_A_PR === "1";
}
