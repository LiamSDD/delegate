import { URL_LIMITS, pathSegments } from "./url";

export const TRAP_DEFAULTS = {
  maxPerPattern: 25,
  maxCalendarPages: 3,
  maxPaginationPage: 5,
} as const;

export type TrapLimits = { [K in keyof typeof TRAP_DEFAULTS]: number };

const DATE_IN_PATH =
  /(^|\/)(19|20)\d{2}([-/_](0?[1-9]|1[0-2]))([-/_](0?[1-9]|[12]\d|3[01]))?(\/|$)/;
const CALENDAR_SEGMENT =
  /^(calendar|calendars|events?-calendar|agenda|schedule|day|week|month|year)$/;
const CALENDAR_PARAM =
  /^(date|day|week|month|year|cal|calendar|start_date|end_date|startdate|enddate|from|to|tribe-bar-date|eventdisplay|ical|time)$/i;
const PAGE_PARAM = /^(page|p|pg|paged|offset|start|skip|cursor|pagenum|page_no|pageno)$/i;
const PAGE_SEGMENT = /^(page|p|pages)$/;

export function urlPattern(url: URL): string {
  const path = pathSegments(url)
    .map((segment) => segment.replace(/\d+/g, "N"))
    .join("/");
  const query = [...url.searchParams.keys()].sort().join("&");
  return `${url.host}/${path}${query === "" ? "" : `?${query}`}`;
}

function paginationNumber(url: URL): number | undefined {
  for (const [key, value] of url.searchParams.entries()) {
    if (PAGE_PARAM.test(key) && /^\d+$/.test(value)) return Number(value);
  }
  const segments = pathSegments(url);
  for (let index = 0; index + 1 < segments.length; index += 1) {
    const next = segments[index + 1] ?? "";
    if (PAGE_SEGMENT.test(segments[index] ?? "") && /^\d+$/.test(next)) return Number(next);
  }
  return undefined;
}

function isCalendarLike(url: URL): boolean {
  const segments = pathSegments(url);
  if (segments.some((segment) => CALENDAR_SEGMENT.test(segment))) {
    if (DATE_IN_PATH.test(url.pathname) || url.search !== "") return true;
  }
  if ([...url.searchParams.keys()].some((key) => CALENDAR_PARAM.test(key))) return true;
  const fullDate = /(^|\/)(19|20)\d{2}-(0[1-9]|1[0-2])(-\d{2})?(\/|$)/.test(url.pathname);
  return fullDate && segments.length <= 3;
}

function repeatsSegments(url: URL): boolean {
  const segments = pathSegments(url);
  if (segments.length > URL_LIMITS.maxPathSegments) return true;
  const counts = new Map<string, number>();
  for (const segment of segments) counts.set(segment, (counts.get(segment) ?? 0) + 1);
  if ([...counts.values()].some((count) => count > URL_LIMITS.maxSegmentRepeats)) return true;
  for (let size = 1; size * 2 <= segments.length; size += 1) {
    const tail = segments.slice(-size).join("/");
    const before = segments.slice(-2 * size, -size).join("/");
    if (size > 1 && tail === before) return true;
  }
  return false;
}

export class TrapGuard {
  private readonly patterns = new Map<string, number>();
  private readonly limits: TrapLimits;
  readonly trapped = new Map<string, number>();

  constructor(limits: Partial<TrapLimits> = {}) {
    this.limits = { ...TRAP_DEFAULTS, ...limits };
  }

  check(raw: string): string | undefined {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return "invalid URL";
    }
    const reason = this.classify(url);
    if (reason !== undefined) this.trapped.set(reason, (this.trapped.get(reason) ?? 0) + 1);
    return reason;
  }

  private classify(url: URL): string | undefined {
    if (repeatsSegments(url)) return "repeating path";
    const page = paginationNumber(url);
    if (page !== undefined && page > this.limits.maxPaginationPage) return "deep pagination";
    const pattern = urlPattern(url);
    const seen = this.patterns.get(pattern) ?? 0;
    const cap = isCalendarLike(url) ? this.limits.maxCalendarPages : this.limits.maxPerPattern;
    if (seen >= cap) return isCalendarLike(url) ? "calendar trap" : "repetitive URL pattern";
    this.patterns.set(pattern, seen + 1);
    return undefined;
  }

  snapshot(): [string, number][] {
    return [...this.patterns.entries()];
  }

  restore(entries: readonly (readonly [string, number])[]): void {
    for (const [pattern, count] of entries) this.patterns.set(pattern, count);
  }
}
