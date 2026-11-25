import { docsRegistry } from "@/lib/docs/registry";
import { buildSearchIndex } from "@/lib/docs/search-index";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(buildSearchIndex(docsRegistry()));
}
