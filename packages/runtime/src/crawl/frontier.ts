import { type UrlSource } from "./priority";

export interface FrontierEntry {
  url: string;
  key: string;
  host: string;
  depth: number;
  score: number;
  source: UrlSource;
  topic?: string;
  lastmod?: string;
  focused?: boolean;
  attempts: number;
  seq: number;
}

function before(a: FrontierEntry, b: FrontierEntry): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.depth !== b.depth) return a.depth < b.depth;
  return a.seq < b.seq;
}

class EntryHeap {
  private readonly items: FrontierEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): FrontierEntry | undefined {
    return this.items[0];
  }

  push(entry: FrontierEntry): void {
    const items = this.items;
    items.push(entry);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const current = items[index];
      const above = items[parent];
      if (current === undefined || above === undefined || !before(current, above)) break;
      items[index] = above;
      items[parent] = current;
      index = parent;
    }
  }

  pop(): FrontierEntry | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    items[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      const leftItem = items[left];
      const rightItem = items[right];
      if (leftItem !== undefined && before(leftItem, items[best] ?? leftItem)) best = left;
      if (rightItem !== undefined && before(rightItem, items[best] ?? rightItem)) best = right;
      if (best === index) break;
      const current = items[index];
      const swap = items[best];
      if (current === undefined || swap === undefined) break;
      items[index] = swap;
      items[best] = current;
      index = best;
    }
    return top;
  }

  values(): readonly FrontierEntry[] {
    return this.items;
  }
}

export class Frontier {
  private readonly heaps = new Map<string, EntryHeap>();
  private readonly seen = new Set<string>();
  private seq = 0;
  private count = 0;

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.count;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  markSeen(key: string): void {
    this.seen.add(key);
  }

  seenKeys(): string[] {
    return [...this.seen];
  }

  full(): boolean {
    return this.count >= this.maxSize;
  }

  add(entry: Omit<FrontierEntry, "seq" | "attempts"> & { attempts?: number }): boolean {
    if (this.seen.has(entry.key) || this.full()) return false;
    this.seen.add(entry.key);
    this.push({ ...entry, attempts: entry.attempts ?? 0, seq: this.seq++ });
    return true;
  }

  requeue(entry: FrontierEntry): void {
    this.push({ ...entry, seq: this.seq++ });
  }

  private push(entry: FrontierEntry): void {
    let heap = this.heaps.get(entry.host);
    if (heap === undefined) {
      heap = new EntryHeap();
      this.heaps.set(entry.host, heap);
    }
    heap.push(entry);
    this.count += 1;
  }

  hosts(): string[] {
    return [...this.heaps.entries()].filter(([, heap]) => heap.size > 0).map(([host]) => host);
  }

  popBest(eligible: (host: string) => boolean): FrontierEntry | undefined {
    let bestHost: string | undefined;
    let bestEntry: FrontierEntry | undefined;
    for (const [host, heap] of this.heaps) {
      const top = heap.peek();
      if (top === undefined || !eligible(host)) continue;
      if (bestEntry === undefined || before(top, bestEntry)) {
        bestEntry = top;
        bestHost = host;
      }
    }
    if (bestHost === undefined) return undefined;
    const entry = this.heaps.get(bestHost)?.pop();
    if (entry !== undefined) this.count -= 1;
    return entry;
  }

  drainHost(host: string): FrontierEntry[] {
    const heap = this.heaps.get(host);
    if (heap === undefined) return [];
    const drained: FrontierEntry[] = [];
    for (let entry = heap.pop(); entry !== undefined; entry = heap.pop()) drained.push(entry);
    this.count -= drained.length;
    return drained;
  }

  entries(limit = Number.POSITIVE_INFINITY): FrontierEntry[] {
    return [...this.heaps.values()]
      .flatMap((heap) => [...heap.values()])
      .sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0))
      .slice(0, limit);
  }
}
