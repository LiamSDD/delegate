import { widgetScript } from "@/lib/agents/embed";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(widgetScript(), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
