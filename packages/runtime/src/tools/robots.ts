interface RobotsRule {
  allow: boolean;
  pattern: string;
  matcher: RegExp;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
}

export interface Robots {
  sitemaps: string[];
  isAllowed(pathWithQuery: string, userAgent: string): boolean;
  crawlDelaySeconds(userAgent: string): number | undefined;
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
    if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
      continue;
    }
    if ((field === "allow" || field === "disallow") && value !== "") {
      current.rules.push({ allow: field === "allow", pattern: value, matcher: compile(value) });
    }
  }

  const groupsFor = (userAgent: string): RobotsGroup[] => {
    const token = productToken(userAgent);
    let best: { length: number; groups: RobotsGroup[] } | undefined;
    for (const group of groups) {
      for (const agent of group.agents) {
        if (agent === "*" || !token.includes(agent)) continue;
        if (best === undefined || agent.length > best.length) {
          best = { length: agent.length, groups: [group] };
        } else if (agent.length === best.length) {
          best = { length: best.length, groups: [...best.groups, group] };
        }
      }
    }
    if (best !== undefined) return best.groups;
    return groups.filter((group) => group.agents.includes("*"));
  };
  const rulesFor = (userAgent: string): RobotsRule[] =>
    groupsFor(userAgent).flatMap((group) => group.rules);

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
    crawlDelaySeconds(userAgent) {
      const delays = groupsFor(userAgent)
        .map((group) => group.crawlDelaySeconds)
        .filter((delay): delay is number => delay !== undefined);
      return delays.length === 0 ? undefined : Math.max(...delays);
    },
  };
}
