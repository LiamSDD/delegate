export const MAX_COMPANY_URL_LENGTH = 2048;

export type CompanyUrlRejection =
  | "empty"
  | "too_long"
  | "scheme"
  | "credentials"
  | "port"
  | "ip_literal"
  | "local_host"
  | "invalid";

export type CompanyUrlResult =
  { ok: true; url: string; domain: string } | { ok: false; reason: CompanyUrlRejection };

export const COMPANY_URL_REJECTION_MESSAGES: Record<CompanyUrlRejection, string> = {
  empty: "Enter a company website, for example acme.com.",
  too_long: "That address is too long to be a company homepage.",
  scheme: "Only http and https websites can be researched.",
  credentials: "Addresses with a username or password are not accepted.",
  port: "Addresses with a custom port are not accepted; use the public homepage.",
  ip_literal: "IP addresses are not accepted; use the company's public domain name.",
  local_host: "Local and internal hostnames are not reachable from the public demo.",
  invalid: "That does not look like a public company website.",
};

const HTTP_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const HOSTNAME = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:[a-z]{2,63}|xn--[a-z\d-]{2,59})$/;
const IPV4_DOTTED = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "arpa", "test", "invalid", "onion"];

function isLocalHost(hostname: string): boolean {
  const tld = hostname.split(".").at(-1) ?? "";
  return LOCAL_SUFFIXES.includes(tld);
}

export function normaliseCompanyUrl(raw: string): CompanyUrlResult {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (text.length > MAX_COMPANY_URL_LENGTH) return { ok: false, reason: "too_long" };
  if (/\s/.test(text)) return { ok: false, reason: "invalid" };
  const hasScheme = HTTP_SCHEME.test(text);
  if (!hasScheme && ANY_SCHEME.test(text) && !/^[^:/]+:\d+(?:[/?#]|$)/.test(text)) {
    return { ok: false, reason: "scheme" };
  }

  let url: URL;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  if (url.port !== "") return { ok: false, reason: "port" };

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.startsWith("[")) return { ok: false, reason: "ip_literal" };
  if (isLocalHost(hostname)) return { ok: false, reason: "local_host" };
  if (IPV4_DOTTED.test(hostname)) return { ok: false, reason: "ip_literal" };
  if (!HOSTNAME.test(hostname)) return { ok: false, reason: "invalid" };

  return {
    ok: true,
    url: `https://${hostname}/`,
    domain: hostname.replace(/^www\./, ""),
  };
}
