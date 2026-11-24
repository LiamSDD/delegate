export type BlockedRange =
  | "unspecified"
  | "loopback"
  | "private"
  | "cgnat"
  | "link-local"
  | "multicast"
  | "reserved"
  | "documentation"
  | "benchmarking"
  | "unique-local"
  | "site-local"
  | "transition"
  | "not-global-unicast"
  | "unparseable";

export type AddressClassification = { allowed: true } | { allowed: false; range: BlockedRange };

const IPV4_PART = /^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/i;

function parseIPv4Part(part: string): number | null {
  if (!IPV4_PART.test(part)) return null;
  if (/^0x/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (part.length > 1 && part.startsWith("0")) return Number.parseInt(part.slice(1), 8);
  return Number.parseInt(part, 10);
}

export function parseIPv4(input: string): number | null {
  const parts = input.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = parseIPv4Part(part);
    if (value === null || !Number.isFinite(value)) return null;
    values.push(value);
  }
  const last = values.pop();
  if (last === undefined) return null;
  if (values.some((value) => value > 255)) return null;
  const lastLimit = 2 ** (8 * (4 - values.length));
  if (last >= lastLimit) return null;
  let address = 0;
  for (const value of values) address = address * 256 + value;
  return address * lastLimit + last;
}

export function parseIPv6(input: string): number[] | null {
  const text = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (text.includes("%") || !/^[0-9a-f:.]+$/i.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    const pieces = segment.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        if (index !== pieces.length - 1 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(piece)) return null;
        const v4 = parseIPv4(piece);
        if (v4 === null) return null;
        groups.push(Math.floor(v4 / 65536), v4 % 65536);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

interface V4Range {
  base: number;
  prefix: number;
  range: BlockedRange;
}

function v4(dotted: string, prefix: number, range: BlockedRange): V4Range {
  const base = parseIPv4(dotted);
  if (base === null) throw new Error(`Invalid range ${dotted}`);
  return { base, prefix, range };
}

const BLOCKED_V4: readonly V4Range[] = [
  v4("0.0.0.0", 8, "unspecified"),
  v4("10.0.0.0", 8, "private"),
  v4("100.64.0.0", 10, "cgnat"),
  v4("127.0.0.0", 8, "loopback"),
  v4("169.254.0.0", 16, "link-local"),
  v4("172.16.0.0", 12, "private"),
  v4("192.0.0.0", 24, "reserved"),
  v4("192.0.2.0", 24, "documentation"),
  v4("192.88.99.0", 24, "transition"),
  v4("192.168.0.0", 16, "private"),
  v4("198.18.0.0", 15, "benchmarking"),
  v4("198.51.100.0", 24, "documentation"),
  v4("203.0.113.0", 24, "documentation"),
  v4("224.0.0.0", 4, "multicast"),
  v4("240.0.0.0", 4, "reserved"),
];

function inV4Range(address: number, range: V4Range): boolean {
  const size = 2 ** (32 - range.prefix);
  return Math.floor(address / size) === Math.floor(range.base / size);
}

function classifyV4(address: number): AddressClassification {
  const match = BLOCKED_V4.find((range) => inV4Range(address, range));
  return match === undefined ? { allowed: true } : { allowed: false, range: match.range };
}

function embeddedV4(groups: readonly number[], high: number, low: number): number {
  return (groups[high] ?? 0) * 65536 + (groups[low] ?? 0);
}

function classifyV6(groups: readonly number[]): AddressClassification {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstSixZero && g5 === 0 && g6 === 0 && g7 === 0)
    return { allowed: false, range: "unspecified" };
  if (firstSixZero && g5 === 0 && g6 === 0 && g7 === 1)
    return { allowed: false, range: "loopback" };
  if (firstSixZero && g5 === 0xffff) return classifyV4(embeddedV4(groups, 6, 7));
  if (firstSixZero && g5 === 0) return { allowed: false, range: "transition" };
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const inner = classifyV4(embeddedV4(groups, 6, 7));
    return inner.allowed ? { allowed: false, range: "transition" } : inner;
  }
  if (g0 === 0x2002) {
    const inner = classifyV4(embeddedV4(groups, 1, 2));
    return inner.allowed ? { allowed: true } : inner;
  }
  if ((g0 & 0xfe00) === 0xfc00) return { allowed: false, range: "unique-local" };
  if ((g0 & 0xffc0) === 0xfe80) return { allowed: false, range: "link-local" };
  if ((g0 & 0xffc0) === 0xfec0) return { allowed: false, range: "site-local" };
  if ((g0 & 0xff00) === 0xff00) return { allowed: false, range: "multicast" };
  if ((g0 & 0xe000) !== 0x2000) return { allowed: false, range: "not-global-unicast" };
  if (g0 === 0x2001 && g1 === 0x0db8) return { allowed: false, range: "documentation" };
  if (g0 === 0x2001 && g1 === 0) return { allowed: false, range: "transition" };
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return { allowed: false, range: "reserved" };
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0020) return { allowed: false, range: "reserved" };
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return { allowed: false, range: "documentation" };
  return { allowed: true };
}

export function classifyAddress(address: string): AddressClassification {
  const trimmed = address.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    const parsed = parseIPv4(trimmed);
    return parsed === null ? { allowed: false, range: "unparseable" } : classifyV4(parsed);
  }
  const groups = parseIPv6(trimmed);
  if (groups === null) return { allowed: false, range: "unparseable" };
  return classifyV6(groups);
}

export function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") || host.includes(":")) return parseIPv6(host) !== null;
  return parseIPv4(host) !== null;
}
