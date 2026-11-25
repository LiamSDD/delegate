import { createHash } from "node:crypto";

export const NEAR_DUPLICATE_DISTANCE = 6;
const SHINGLE_WORDS = 2;
const MASK64 = (1n << 64n) - 1n;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(words(text).join(" ")).digest("hex");
}

export function simhash(text: string): bigint {
  const tokens = words(text);
  const weights = new Array<number>(64).fill(0);
  const count = Math.max(1, tokens.length - SHINGLE_WORDS + 1);
  for (let index = 0; index < count; index += 1) {
    const shingle = tokens.slice(index, index + SHINGLE_WORDS).join(" ");
    if (shingle === "") continue;
    let hash = fnv1a64(shingle);
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] = (weights[bit] ?? 0) + ((hash & 1n) === 1n ? 1 : -1);
      hash >>= 1n;
    }
  }
  let result = 0n;
  for (let bit = 63; bit >= 0; bit -= 1) {
    result = (result << 1n) | ((weights[bit] ?? 0) > 0 ? 1n : 0n);
  }
  return result;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let distance = 0;
  while (diff !== 0n) {
    diff &= diff - 1n;
    distance += 1;
  }
  return distance;
}

export function toHex(hash: bigint): string {
  return hash.toString(16).padStart(16, "0");
}

export function fromHex(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

export class DuplicateIndex {
  private readonly exact = new Map<string, string>();
  private readonly near: { hash: bigint; url: string }[] = [];
  private readonly bands = new Map<string, number[]>();

  constructor(private readonly maxDistance = NEAR_DUPLICATE_DISTANCE) {}

  find(hash: string, sim?: bigint): { url: string; kind: "exact" | "near" } | undefined {
    const exact = this.exact.get(hash);
    if (exact !== undefined) return { url: exact, kind: "exact" };
    if (sim === undefined) return undefined;
    const candidates = new Set<number>();
    for (const band of this.bandKeys(sim))
      for (const index of this.bands.get(band) ?? []) candidates.add(index);
    for (const index of candidates) {
      const entry = this.near[index];
      if (entry !== undefined && hammingDistance(entry.hash, sim) <= this.maxDistance)
        return { url: entry.url, kind: "near" };
    }
    return undefined;
  }

  add(hash: string, sim: bigint | undefined, url: string): void {
    if (!this.exact.has(hash)) this.exact.set(hash, url);
    if (sim === undefined) return;
    const index = this.near.push({ hash: sim, url }) - 1;
    for (const band of this.bandKeys(sim))
      this.bands.set(band, [...(this.bands.get(band) ?? []), index]);
  }

  entries(): { hash: string; simhash: string; url: string }[] {
    const sims = new Map(this.near.map((entry) => [entry.url, toHex(entry.hash)]));
    return [...this.exact.entries()].map(([hash, url]) => ({
      hash,
      simhash: sims.get(url) ?? "",
      url,
    }));
  }

  private bandKeys(sim: bigint): string[] {
    const keys: string[] = [];
    const bandBits = 8;
    for (let band = 0; band < 64 / bandBits; band += 1) {
      const value = (sim >> BigInt(band * bandBits)) & ((1n << BigInt(bandBits)) - 1n);
      keys.push(`${band}:${value.toString(16)}`);
    }
    return keys;
  }
}
