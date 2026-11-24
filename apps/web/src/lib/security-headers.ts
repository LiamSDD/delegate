import { createHash, randomBytes } from "node:crypto";

import { themeInitScript } from "./theme";

export const CSP_HEADER = "Content-Security-Policy";
export const NONCE_REQUEST_HEADER = "x-nonce";

export const THEME_INIT_SCRIPT_HASH = `'sha256-${createHash("sha256")
  .update(themeInitScript, "utf8")
  .digest("base64")}'`;

const NONCE_PATTERN = /^[A-Za-z0-9+/]+=*$/;

export function createNonce(): string {
  return randomBytes(16).toString("base64");
}

export interface CspOptions {
  nonce: string;
  isDev: boolean;
}

export function buildContentSecurityPolicy({ nonce, isDev }: CspOptions): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("CSP nonce must be base64");
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, THEME_INIT_SCRIPT_HASH, "'strict-dynamic'"];
  if (isDev) scriptSrc.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}
