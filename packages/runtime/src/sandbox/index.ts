import { createLocalSandboxProvider } from "./local";
import {
  SANDBOX_KINDS,
  SandboxUnavailableError,
  type SandboxKind,
  type SandboxProvider,
} from "./types";
import { createVercelSandboxProvider } from "./vercel";

export interface SandboxEnv {
  NODE_ENV?: string | undefined;
  DELEGATE_SANDBOX?: string | undefined;
}

export function sandboxKindFor(env: SandboxEnv): SandboxKind {
  const requested = env.DELEGATE_SANDBOX?.trim().toLowerCase();
  if (requested === undefined || requested === "")
    return env.NODE_ENV === "production" ? "vercel" : "local";
  const kind = SANDBOX_KINDS.find((candidate) => candidate === requested);
  if (kind === undefined)
    throw new SandboxUnavailableError(
      `DELEGATE_SANDBOX must be one of ${SANDBOX_KINDS.join(", ")}`,
    );
  return kind;
}

export function createSandboxProvider(env: SandboxEnv): SandboxProvider {
  return sandboxKindFor(env) === "vercel"
    ? createVercelSandboxProvider()
    : createLocalSandboxProvider({ production: env.NODE_ENV === "production" });
}

export * from "./types";
export * from "./paths";
export { createLocalSandboxProvider, scrubbedEnv } from "./local";
export { NETWORK_POLICIES, createVercelSandboxProvider, sanitiseProviderError } from "./vercel";
