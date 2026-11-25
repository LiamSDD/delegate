import { type NextRequest, NextResponse } from "next/server";

import { isEmbedPath } from "@/lib/agents/embed";
import {
  buildContentSecurityPolicy,
  EMBED_REQUEST_HEADER,
  createNonce,
  CSP_HEADER,
  NONCE_REQUEST_HEADER,
} from "@/lib/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const embed = isEmbedPath(request.nextUrl.pathname);
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    frameable: embed,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(EMBED_REQUEST_HEADER);
  if (embed) requestHeaders.set(EMBED_REQUEST_HEADER, "1");
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
