const TRACKING_PARAM =
  /^(utm_[a-z_]+|gclid|gclsrc|dclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|__hstc|__hssc|__hsfp|hsctatracking|_ga|_gl|ref|ref_src|referrer|source|si|spm|trk|cmpid|campaign|affiliate|aff_id|sessionid|session_id|sid|jsessionid|phpsessid|cfid|cftoken)$/i;
const SESSION_PATH_PARAM = /;(jsessionid|phpsessid|sid)=[^/?#]*/gi;
const INDEX_FILE = /\/(index|default)\.(html?|php|aspx?)$/i;

export const ASSET_EXTENSION =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|heic|pdf|docx?|xlsx?|pptx?|odt|csv|zip|gz|tgz|bz2|xz|rar|7z|dmg|exe|msi|apk|deb|rpm|iso|mp4|m4v|mov|avi|wmv|webm|mkv|mp3|m4a|wav|ogg|flac|css|js|mjs|map|wasm|json|xml|txt|rss|atom|ics|vcf|woff2?|ttf|otf|eot)$/i;
const ACTION_SEGMENT =
  /^(login|log-in|logout|log-out|signin|sign-in|signout|sign-out|signup|sign-up|register|auth|oauth2?|sso|saml|callback|cart|basket|checkout|account|my-account|profile|settings|wp-admin|wp-login\.php|wp-json|xmlrpc\.php|cdn-cgi|admin|search|feed|feeds|rss|tag|tags|author|print|share|preview|unsubscribe|password-reset|reset-password|forgot-password|cgi-bin)$/i;
const ACTION_PARAM =
  /^(add-to-cart|add_to_cart|action|replytocom|share|print|sort|sortby|sort_by|order|orderby|filter|filters|format|lang|output|view|display|s|q|query|search|keyword|keywords|redirect|redirect_to|return|return_to|returnurl|next|ical|outlook-ical|download|attachment_id|preview|amp)$/i;
const LANGUAGE_CODES = new Set(
  "ar bg cs da de el en es et fa fi fr he hi hr hu id it ja ko lt lv ms nb nl no pl pt ro ru sk sl sr sv th tr uk vi zh".split(
    " ",
  ),
);

export function localeOf(segment: string | undefined): string | undefined {
  const match = /^([a-z]{2})(?:[-_][a-z]{2,4})?$/i.exec(segment ?? "");
  const language = match?.[1]?.toLowerCase();
  return language !== undefined && LANGUAGE_CODES.has(language) ? language : undefined;
}

export const URL_LIMITS = {
  maxLength: 300,
  maxQueryParams: 3,
  maxPathSegments: 8,
  maxSegmentRepeats: 2,
} as const;

export function normaliseUrl(raw: string, base?: string): string | undefined {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw.trim()) : new URL(raw.trim(), base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  const path = url.pathname.replace(SESSION_PATH_PARAM, "").replace(/\/{2,}/g, "/");
  url.pathname = path === "" ? "/" : path;
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.href;
}

export function urlKey(normalised: string): string {
  try {
    const url = new URL(normalised);
    const host = url.hostname.replace(/^www\./, "");
    let path = url.pathname.toLowerCase().replace(INDEX_FILE, "/");
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `${host}${url.port === "" ? "" : `:${url.port}`}${path}${url.search}`;
  } catch {
    return normalised;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    });
}

export function nonContentReason(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "not http";
  if (url.username !== "" || url.password !== "") return "credentials in URL";
  if (raw.length > URL_LIMITS.maxLength) return "URL too long";
  if (ASSET_EXTENSION.test(url.pathname)) return "asset or binary";
  const segments = pathSegments(url);
  if (segments.some((segment) => ACTION_SEGMENT.test(segment))) return "auth, cart or utility page";
  const keys = [...new Set(url.searchParams.keys())];
  if (keys.some((key) => ACTION_PARAM.test(key))) return "action or search parameter";
  if (keys.length > URL_LIMITS.maxQueryParams) return "too many query parameters";
  return undefined;
}

export function otherLocale(url: URL, start: URL): boolean {
  const first = pathSegments(url)[0];
  const locale = localeOf(first);
  if (locale === undefined || locale === "en") return false;
  return first !== pathSegments(start)[0];
}
