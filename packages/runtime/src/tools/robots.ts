interface RobotsRule {
  allow: boolean;
  pattern: string;
  matcher: RegExp;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface Robots {
  sitemaps: string[];
  isAllowed(pathWithQuery: string, userAgent: string): boolean;
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

function productToken(userAgent: string): string {
  return (userAgent.split("/")[0] ?? userAgent).trim().toLowerCase();
}

export function parseRobots(source: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "sitemap") {
      if (value !== "") sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === undefined) continue;
    if ((field === "allow" || field === "disallow") && value !== "") {
      current.rules.push({ allow: field === "allow", pattern: value, matcher: compile(value) });
    }
  }

  const rulesFor = (userAgent: string): RobotsRule[] => {
    const token = productToken(userAgent);
    let best: { length: number; rules: RobotsRule[] } | undefined;
    for (const group of groups) {
      for (const agent of group.agents) {
        if (agent === "*" || !token.includes(agent)) continue;
        if (best === undefined || agent.length > best.length) {
          best = { length: agent.length, rules: group.rules };
        } else if (agent.length === best.length) {
          best = { length: best.length, rules: [...best.rules, ...group.rules] };
        }
      }
    }
    if (best !== undefined) return best.rules;
    return groups.filter((group) => group.agents.includes("*")).flatMap((group) => group.rules);
  };

  return {
    sitemaps,
    isAllowed(pathWithQuery, userAgent) {
      let winner: RobotsRule | undefined;
      for (const rule of rulesFor(userAgent)) {
        if (!rule.matcher.test(pathWithQuery)) continue;
        if (
          winner === undefined ||
          rule.pattern.length > winner.pattern.length ||
          (rule.pattern.length === winner.pattern.length && rule.allow)
        ) {
          winner = rule;
        }
      }
      return winner === undefined || winner.allow;
    },
  };
}
