import { z } from "zod";

import { type QuarantineTask } from "../../quarantine/reader";
import { type SectionKey } from "./brief";

export const XRAY_TOPICS = [
  "company",
  "offering",
  "customers",
  "market",
  "competitors",
  "positioning",
  "news",
  "tech",
  "people",
  "other",
] as const;
export type XrayTopic = (typeof XRAY_TOPICS)[number];

export const TOPIC_FOR_SECTION: Record<Exclude<SectionKey, "swot">, XrayTopic> = {
  offering: "offering",
  customers: "customers",
  market: "market",
  competitors: "competitors",
  positioning: "positioning",
  news: "news",
  techStack: "tech",
};

export const XRAY_READER_TASK: QuarantineTask<{ topic: XrayTopic }> = {
  name: "company-xray",
  instructions:
    "Extract facts about the company whose public footprint is being researched: what it sells, who its customers and target segments are, which market or industry it serves, competitors or comparison targets it names, how it positions itself, dated news and announcements, technologies and integrations it uses or mentions, and company facts such as founding date, headquarters, size and leadership.",
  extraSchema: z.object({ topic: z.enum(XRAY_TOPICS).catch("other") }),
  extraDescription: `"topic": one of ${XRAY_TOPICS.join(", ")}`,
  maxFactsPerSource: 6,
};
