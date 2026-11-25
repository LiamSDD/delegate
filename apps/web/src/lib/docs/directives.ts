export const LIVE_DIRECTIVES = ["redteam-summary", "adr-index", "openapi-reference"] as const;

export type LiveDirective = (typeof LIVE_DIRECTIVES)[number];

export function isLiveDirective(name: string): name is LiveDirective {
  return (LIVE_DIRECTIVES as readonly string[]).includes(name);
}
