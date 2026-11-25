export const TARGET_LIMITS = {
  brandCandidates: 3,
  topicQueries: 3,
  queryWords: 5,
} as const;

const DOMAIN =
  /(?:https?:\/\/)?((?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:[a-z]{2,63}|xn--[a-z\d-]{2,59}))(\/[^\s"'<>)\],;]*)?/gi;
const CODE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
const NOT_TLDS = new Set(["js", "ts", "py", "rs", "go", "md", "json", "yaml", "yml", "txt"]);

const STOPWORDS = new Set(
  `a an the and or but if then else of to in on at for from by with without into onto over under about as is are was were be been being do does did done have has had having i me my mine we us our ours you your yours he she it its they them their this that these those there here what which who whom whose when where why how all any both each few more most other some such no nor not only own same so than too very can will just should would could might must shall may want wants wanted need needs needed like get gets got make makes made help helps let lets achieve achieving improve improving build building create creating plan planning figure find out understand know learn start started using use used work works working way ways thing things stuff better best new good great really please also into across within around up down onto via per vs`.split(
    /\s+/,
  ),
);
const GENERIC_CAPITALISED = new Set([
  "ai",
  "api",
  "b2b",
  "b2c",
  "ceo",
  "cto",
  "cfo",
  "crm",
  "erp",
  "faq",
  "gdpr",
  "hr",
  "it",
  "kpi",
  "kpis",
  "llm",
  "ml",
  "okr",
  "okrs",
  "q1",
  "q2",
  "q3",
  "q4",
  "roi",
  "saas",
  "seo",
  "sla",
  "ui",
  "ux",
  "europe",
  "european",
  "us",
  "usa",
  "uk",
  "eu",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
]);

export interface DomainMention {
  url: string;
  host: string;
}

export interface GoalTarget {
  domain: DomainMention | null;
  brands: string[];
  queries: string[];
}

function cleanHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function repoOwner(host: string, path: string | undefined): string | undefined {
  if (!CODE_HOSTS.has(host) || path === undefined) return undefined;
  const owner = path.split("/").find((segment) => segment !== "");
  return owner !== undefined && /^[a-z\d][a-z\d-]{0,38}$/i.test(owner) ? owner : undefined;
}

function domainMatches(goal: string): { host: string; path: string | undefined }[] {
  const found: { host: string; path: string | undefined }[] = [];
  for (const match of goal.matchAll(DOMAIN)) {
    const start = match.index;
    if (start > 0 && /[@\w.-]/.test(goal.charAt(start - 1))) continue;
    const rawHost = match[1];
    if (rawHost === undefined) continue;
    const host = cleanHost(rawHost);
    const tld = host.split(".").at(-1) ?? "";
    if (!/^https?:\/\//i.test(match[0]) && NOT_TLDS.has(tld)) continue;
    found.push({ host, path: match[2] });
  }
  return found;
}

export function extractDomain(goal: string): DomainMention | null {
  for (const { host, path } of domainMatches(goal)) {
    if (repoOwner(host, path) !== undefined) continue;
    if (CODE_HOSTS.has(host) && path !== undefined && path !== "/") continue;
    return { url: `https://${host}/`, host };
  }
  return null;
}

function words(text: string): string[] {
  return text
    .replace(DOMAIN, " ")
    .split(/[^\p{L}\p{N}'’&-]+/u)
    .map((word) => word.replace(/^[-'’&]+|[-'’&]+$/g, ""))
    .filter((word) => word !== "");
}

function possessiveBase(word: string): string | undefined {
  const match = /^(.+?)['’]s$/i.exec(word) ?? /^(.+s)['’]$/i.exec(word);
  return match?.[1];
}

function isCandidate(word: string): boolean {
  const lower = word.toLowerCase();
  return (
    word.length >= 2 &&
    word.length <= 40 &&
    !STOPWORDS.has(lower) &&
    !GENERIC_CAPITALISED.has(lower) &&
    !/^\d+$/.test(word)
  );
}

export function brandCandidates(goal: string): string[] {
  const candidates: string[] = [];
  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed === "" || candidates.some((c) => c.toLowerCase() === trimmed.toLowerCase())) return;
    candidates.push(trimmed);
  };
  for (const { host, path } of domainMatches(goal)) {
    const owner = repoOwner(host, path);
    if (owner !== undefined) add(owner);
  }
  const tokens = words(goal);
  for (const token of tokens) {
    const base = possessiveBase(token);
    if (base !== undefined && isCandidate(base)) add(base);
  }
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) add(run.join(" "));
    run = [];
  };
  tokens.forEach((token, index) => {
    const bare = possessiveBase(token) ?? token;
    if (index > 0 && /^\p{Lu}/u.test(bare) && isCandidate(bare)) {
      run.push(bare);
      if (possessiveBase(token) !== undefined) flush();
    } else flush();
  });
  flush();
  return candidates.slice(0, TARGET_LIMITS.brandCandidates);
}

export function topicQueries(goal: string, exclude: readonly string[]): string[] {
  const excluded = new Set(
    exclude.flatMap((name) => name.toLowerCase().split(/\s+/)).filter((word) => word !== ""),
  );
  const clauses = goal
    .replace(DOMAIN, " ")
    .split(/\s*(?:,|;|\band\b|\bor\b|\bplus\b|&|\/|\.\s)\s*/i)
    .map((clause) =>
      words(clause)
        .map((word) => possessiveBase(word) ?? word)
        .filter((word) => !STOPWORDS.has(word.toLowerCase()))
        .filter((word) => !excluded.has(word.toLowerCase()))
        .filter((word) => !/^\d+$/.test(word))
        .slice(0, TARGET_LIMITS.queryWords)
        .join(" "),
    )
    .filter((query) => query.length >= 3);
  const unique: string[] = [];
  for (const query of clauses)
    if (!unique.some((existing) => existing.toLowerCase() === query.toLowerCase()))
      unique.push(query);
  return unique.slice(0, TARGET_LIMITS.topicQueries);
}

export function analyseGoal(goal: string, url?: string): GoalTarget {
  const domain =
    url === undefined ? extractDomain(goal) : { url, host: cleanHost(new URL(url).hostname) };
  const brands = domain === null ? brandCandidates(goal) : [];
  const label = domain?.host.split(".")[0];
  const queries = topicQueries(goal, [...brands, ...(label === undefined ? [] : [label])]);
  return { domain, brands, queries };
}
