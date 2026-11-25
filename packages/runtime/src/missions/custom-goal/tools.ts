import { CAPABILITIES } from "@delegate/policy";
import { z } from "zod";

import { FetchBlockedError, type Fetcher } from "../../tools/fetch";
import { defineTool, type RegisteredTool } from "../../tools/registry";
import { type SourceDocument, type SourceStore } from "../../tools/sources";
import { CompanyUrlSchema } from "../company-xray/input";
import { type GoalCompany } from "./schema";

export const GOAL_TOOL_LIMITS = {
  brandLookups: 3,
  searchHits: 5,
  hitsPerQuery: 2,
  referenceSources: 4,
  minExtractChars: 80,
} as const;

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const JSON_ACCEPT = "application/json";
const CODE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
const CORPORATE_SUFFIX =
  /[\s,]+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|gmbh|ag|sa|se|nv|bv|group|holdings?)\.?$/i;

const WikidataSearchSchema = z.object({
  search: z.array(z.object({ id: z.string() })).default([]),
});
const SnakValueSchema = z.object({
  mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }),
});
const WikidataEntitiesSchema = z.object({
  entities: z.record(
    z.string(),
    z.object({
      labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
      claims: z.record(z.string(), z.array(SnakValueSchema)).optional(),
    }),
  ),
});
const WikipediaSearchSchema = z.object({
  query: z.object({ search: z.array(z.object({ title: z.string() })).default([]) }).optional(),
});
const WikipediaExtractsSchema = z.object({
  query: z
    .object({
      pages: z
        .record(z.string(), z.object({ title: z.string(), extract: z.string().optional() }))
        .default({}),
    })
    .optional(),
});

async function getJson<T>(
  fetcher: Fetcher,
  base: string,
  params: Record<string, string>,
  schema: z.ZodType<T>,
  signal: AbortSignal | undefined,
): Promise<{ value: T; fetchedAt: string }> {
  const url = new URL(base);
  for (const [key, value] of Object.entries({ ...params, format: "json" }))
    url.searchParams.set(key, value);
  try {
    const document = await fetcher.fetch({
      url: url.href,
      respectRobots: false,
      accept: JSON_ACCEPT,
      ...(signal === undefined ? {} : { signal }),
    });
    return { value: schema.parse(JSON.parse(document.text)), fetchedAt: document.fetchedAt };
  } catch (error) {
    if (error instanceof FetchBlockedError)
      throw new Error(`${error.code}: ${error.message}`, { cause: error });
    throw error;
  }
}

function comparable(name: string): string {
  return name
    .toLowerCase()
    .replace(CORPORATE_SUFFIX, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function labelMatches(label: string, candidate: string): boolean {
  const a = comparable(label);
  const b = comparable(candidate);
  return a !== "" && b !== "" && (a === b || a.startsWith(`${b} `));
}

function officialSite(claims: Record<string, z.infer<typeof SnakValueSchema>[]> | undefined) {
  for (const snak of claims?.P856 ?? []) {
    const value = snak.mainsnak.datavalue?.value;
    if (typeof value !== "string") continue;
    const parsed = CompanyUrlSchema.safeParse(value);
    if (!parsed.success) continue;
    const url = new URL(parsed.data);
    if (CODE_HOSTS.has(url.hostname.replace(/^www\./, ""))) continue;
    return `${url.origin}/`;
  }
  return undefined;
}

export interface CompanyResolver {
  tool: RegisteredTool;
  resolved: () => GoalCompany | null;
}

export function createCompanyResolver(fetcher: Fetcher, signal?: AbortSignal): CompanyResolver {
  let resolved: GoalCompany | null = null;
  const tool = defineTool({
    name: "resolve_company",
    description:
      "Find the official website of a company named in the goal: Wikidata search, accepting only an entity whose label matches the name and that lists an official website.",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({
      names: z.array(z.string().trim().min(2).max(80)).min(1).max(GOAL_TOOL_LIMITS.brandLookups),
    }),
    targetDomain: () => "www.wikidata.org",
    summariseArgs: (input) => `Wikidata lookup for ${input.names.join(", ")}`,
    execute: async (input) => {
      for (const name of input.names) {
        const search = await getJson(
          fetcher,
          WIKIDATA_API,
          {
            action: "wbsearchentities",
            search: name,
            language: "en",
            type: "item",
            limit: String(GOAL_TOOL_LIMITS.searchHits),
          },
          WikidataSearchSchema,
          signal,
        );
        const ids = search.value.search.map((hit) => hit.id).filter((id) => /^Q\d+$/.test(id));
        if (ids.length === 0) continue;
        const entities = await getJson(
          fetcher,
          WIKIDATA_API,
          { action: "wbgetentities", ids: ids.join("|"), props: "claims|labels", languages: "en" },
          WikidataEntitiesSchema,
          signal,
        );
        for (const id of ids) {
          const entity = entities.value.entities[id];
          const label = entity?.labels?.en?.value;
          if (entity === undefined || label === undefined || !labelMatches(label, name)) continue;
          const url = officialSite(entity.claims);
          if (url === undefined) continue;
          resolved = { name: label, url, resolvedBy: "wikidata", entity: id };
          return {
            summary: `Resolved ${name} to ${label} (${id}), official site ${url}`,
            forModel: `Wikidata ${id} "${label}" lists ${url} as its official website.`,
          };
        }
      }
      return {
        summary: `No Wikidata entity with an official website matches ${input.names.join(", ")}`,
        forModel: "No company could be resolved; nothing was guessed.",
      };
    },
  });
  return { tool, resolved: () => resolved };
}

export interface ReferenceSearch {
  tool: RegisteredTool;
  created: () => SourceDocument[];
}

export function createReferenceSearch(
  fetcher: Fetcher,
  store: SourceStore,
  signal?: AbortSignal,
): ReferenceSearch {
  const created: SourceDocument[] = [];
  const tool = defineTool({
    name: "search_reference",
    description:
      "Search English Wikipedia for the goal's topics and keep the introductions of the best matches as sources for the quarantined reader.",
    capability: CAPABILITIES.webFetch,
    inputSchema: z.object({
      queries: z.array(z.string().trim().min(2).max(120)).min(1).max(3),
    }),
    targetDomain: () => "en.wikipedia.org",
    summariseArgs: (input) => `Wikipedia search for ${input.queries.join("; ")}`,
    execute: async (input) => {
      const titles: string[] = [];
      for (const query of input.queries) {
        const search = await getJson(
          fetcher,
          WIKIPEDIA_API,
          {
            action: "query",
            list: "search",
            srsearch: query,
            srnamespace: "0",
            srlimit: String(GOAL_TOOL_LIMITS.hitsPerQuery),
          },
          WikipediaSearchSchema,
          signal,
        );
        for (const hit of search.value.query?.search ?? [])
          if (!titles.includes(hit.title)) titles.push(hit.title);
      }
      const picked = titles.slice(0, GOAL_TOOL_LIMITS.referenceSources);
      if (picked.length === 0)
        return { summary: "No reference articles matched", forModel: "No sources were added." };
      const extracts = await getJson(
        fetcher,
        WIKIPEDIA_API,
        {
          action: "query",
          prop: "extracts",
          exintro: "1",
          explaintext: "1",
          redirects: "1",
          titles: picked.join("|"),
        },
        WikipediaExtractsSchema,
        signal,
      );
      for (const page of Object.values(extracts.value.query?.pages ?? {})) {
        const text = page.extract?.trim() ?? "";
        if (text.length < GOAL_TOOL_LIMITS.minExtractChars) continue;
        const added = store.add({
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
          title: `Wikipedia: ${page.title}`,
          kind: "wikipedia",
          fetchedAt: extracts.fetchedAt,
          text,
        });
        if (added.created) created.push(added.document);
      }
      const ids = created.map((document) => document.record.sourceId);
      return {
        summary: `Collected ${created.length} reference article(s) for ${input.queries.length} topic(s)`,
        forModel:
          ids.length === 0
            ? "No usable reference text."
            : `Collected ${ids.join(", ")}. Facts are extracted by the quarantined reader.`,
      };
    },
  });
  return { tool, created: () => [...created] };
}
