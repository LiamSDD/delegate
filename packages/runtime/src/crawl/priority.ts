import { localeOf, pathSegments } from "./url";

export interface CrawlTopic {
  name: string;
  weight: number;
  terms: readonly string[];
}

export interface CrawlProfile {
  id: string;
  topics: readonly CrawlTopic[];
  depthPenalty: number;
  segmentPenalty: number;
}

export type UrlSource = "seed" | "sitemap" | "feed" | "link";

export interface ScoreInput {
  url: string;
  depth: number;
  source: UrlSource;
  anchorText?: string;
  lastmod?: string;
  inMainContent?: boolean;
  nowMs: number;
}

export interface UrlScore {
  score: number;
  topic?: string;
}

const COMPANY_TOPICS: readonly CrawlTopic[] = [
  {
    name: "about",
    weight: 45,
    terms: [
      "about",
      "about-us",
      "company",
      "who-we-are",
      "our-story",
      "team",
      "leadership",
      "mission",
      "investors",
    ],
  },
  { name: "pricing", weight: 45, terms: ["pricing", "plans", "price", "prices"] },
  {
    name: "product",
    weight: 40,
    terms: [
      "product",
      "products",
      "platform",
      "features",
      "solutions",
      "services",
      "how-it-works",
      "use-cases",
      "industries",
    ],
  },
  {
    name: "customers",
    weight: 40,
    terms: [
      "customers",
      "customer",
      "case-studies",
      "case-study",
      "success-stories",
      "testimonials",
      "clients",
      "stories",
    ],
  },
  {
    name: "comparisons",
    weight: 30,
    terms: ["vs", "compare", "comparison", "alternatives", "alternative"],
  },
  {
    name: "security",
    weight: 30,
    terms: ["security", "trust", "compliance", "gdpr", "soc2", "soc-2", "privacy-center"],
  },
  {
    name: "careers",
    weight: 30,
    terms: ["careers", "jobs", "join-us", "hiring", "work-with-us", "open-positions"],
  },
  {
    name: "integrations",
    weight: 25,
    terms: ["integrations", "partners", "partner", "marketplace", "ecosystem"],
  },
  {
    name: "news",
    weight: 25,
    terms: ["news", "press", "newsroom", "media", "blog", "updates", "changelog", "announcements"],
  },
  {
    name: "docs",
    weight: 20,
    terms: ["docs", "documentation", "developers", "api", "help", "support", "faq", "guides"],
  },
  { name: "contact", weight: 15, terms: ["contact", "contact-us", "locations", "offices"] },
  { name: "legal", weight: 10, terms: ["legal", "imprint", "impressum", "terms", "privacy"] },
];

export const COMPANY_PROFILE: CrawlProfile = {
  id: "company",
  topics: COMPANY_TOPICS,
  depthPenalty: 10,
  segmentPenalty: 6,
};

export const AUDIT_PROFILE: CrawlProfile = {
  id: "audit",
  topics: [
    { name: "product", weight: 45, terms: COMPANY_TOPICS[2]?.terms ?? [] },
    {
      name: "support",
      weight: 40,
      terms: ["support", "help", "faq", "contact", "service", "returns", "shipping", "onboarding"],
    },
    {
      name: "pricing",
      weight: 40,
      terms: ["pricing", "plans", "price", "quote", "book", "booking"],
    },
    {
      name: "careers",
      weight: 35,
      terms: ["careers", "jobs", "join-us", "hiring", "open-positions"],
    },
    { name: "customers", weight: 35, terms: COMPANY_TOPICS[3]?.terms ?? [] },
    { name: "about", weight: 30, terms: COMPANY_TOPICS[0]?.terms ?? [] },
    { name: "integrations", weight: 25, terms: ["integrations", "partners", "api", "developers"] },
    { name: "docs", weight: 20, terms: ["docs", "documentation", "guides", "resources"] },
    { name: "news", weight: 10, terms: ["news", "blog", "press"] },
  ],
  depthPenalty: 10,
  segmentPenalty: 6,
};

export const DOCS_PROFILE: CrawlProfile = {
  id: "docs",
  topics: [
    {
      name: "docs",
      weight: 45,
      terms: [
        "docs",
        "documentation",
        "help",
        "support",
        "faq",
        "faqs",
        "guide",
        "guides",
        "kb",
        "knowledge-base",
        "manual",
        "tutorials",
        "tutorial",
        "getting-started",
        "reference",
        "api",
        "how-to",
        "learn",
        "academy",
        "resources",
      ],
    },
    { name: "pricing", weight: 35, terms: ["pricing", "plans", "billing"] },
    { name: "product", weight: 30, terms: COMPANY_TOPICS[2]?.terms ?? [] },
    {
      name: "policies",
      weight: 25,
      terms: [
        "security",
        "privacy",
        "terms",
        "legal",
        "returns",
        "shipping",
        "refunds",
        "warranty",
        "sla",
      ],
    },
    { name: "about", weight: 20, terms: ["about", "about-us", "company", "contact", "contact-us"] },
    { name: "news", weight: 5, terms: ["blog", "news", "changelog", "releases"] },
  ],
  depthPenalty: 4,
  segmentPenalty: 3,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function termMatches(segment: string, term: string): boolean {
  return (
    segment === term ||
    segment.startsWith(`${term}-`) ||
    segment.endsWith(`-${term}`) ||
    segment.includes(`-${term}-`)
  );
}

export function scoreUrl(profile: CrawlProfile, input: ScoreInput): UrlScore {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { score: Number.NEGATIVE_INFINITY };
  }
  const segments = pathSegments(url);
  const localised = localeOf(segments[0]) !== undefined;
  const content = localised ? segments.slice(1) : segments;
  const anchor = (input.anchorText ?? "").toLowerCase().replace(/\s+/g, "-");
  let best: CrawlTopic | undefined;
  for (const topic of profile.topics) {
    const inPath = content
      .slice(0, 3)
      .some((segment) => topic.terms.some((term) => termMatches(segment, term)));
    const inAnchor = anchor !== "" && topic.terms.some((term) => termMatches(anchor, term));
    if ((inPath || inAnchor) && (best === undefined || topic.weight > best.weight)) best = topic;
  }
  let score = 100;
  score -= input.depth * profile.depthPenalty;
  score -= Math.max(0, content.length - 1) * profile.segmentPenalty;
  score += best?.weight ?? 0;
  if (localised) score -= 20;
  if (url.search !== "") score -= 15;
  if (input.source === "seed") score += 1_000;
  if (input.source === "sitemap") score += 5;
  if (input.inMainContent === true) score += 5;
  if (input.lastmod !== undefined) {
    const age = input.nowMs - Date.parse(input.lastmod);
    if (Number.isFinite(age) && age < 365 * DAY_MS) score += 5;
    if (Number.isFinite(age) && age > 3 * 365 * DAY_MS) score -= 5;
  }
  return { score, ...(best === undefined ? {} : { topic: best.name }) };
}
