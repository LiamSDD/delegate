export type JsonReading =
  | { ok: true; value: unknown; truncated: boolean; repaired: boolean }
  | { ok: false; truncated: boolean };

const MAX_DEPTH = 64;
const MAX_STARTS = 12;
const INCOMPLETE = Symbol("incomplete");
const VALUE_TERMINATORS = new Set([",", "}", "]"]);
const WORDS: Record<string, unknown> = {
  true: true,
  false: false,
  null: null,
  none: null,
  undefined: null,
};
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  "/": "/",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

class SyntaxProblem extends Error {
  override readonly name = "SyntaxProblem";
}

class TolerantParser {
  cut = false;

  constructor(
    private readonly text: string,
    public pos: number,
  ) {}

  private get done(): boolean {
    return this.pos >= this.text.length;
  }

  private skipTrivia(): void {
    for (;;) {
      const char = this.text[this.pos];
      if (char === undefined) return;
      if (/\s/.test(char)) this.pos += 1;
      else if (this.text.startsWith("//", this.pos)) {
        const end = this.text.indexOf("\n", this.pos);
        this.pos = end === -1 ? this.text.length : end + 1;
      } else if (this.text.startsWith("/*", this.pos)) {
        const end = this.text.indexOf("*/", this.pos + 2);
        this.pos = end === -1 ? this.text.length : end + 2;
      } else return;
    }
  }

  value(depth: number): unknown {
    this.skipTrivia();
    const char = this.text[this.pos];
    if (char === undefined) return INCOMPLETE;
    if (depth > MAX_DEPTH) throw new SyntaxProblem("too deep");
    if (char === "{") return this.object(depth);
    if (char === "[") return this.array(depth);
    if (char === '"' || char === "'") return this.string(char, false);
    if (char === "-" || (char >= "0" && char <= "9")) return this.number();
    if (/[A-Za-z]/.test(char)) return this.word();
    throw new SyntaxProblem(`unexpected ${char}`);
  }

  private object(depth: number): Record<string, unknown> {
    this.pos += 1;
    const result: Record<string, unknown> = {};
    for (;;) {
      this.skipTrivia();
      const char = this.text[this.pos];
      if (char === undefined) {
        this.cut = true;
        return result;
      }
      if (char === "}") {
        this.pos += 1;
        return result;
      }
      if (char === "]") return result;
      if (char === ",") {
        this.pos += 1;
        continue;
      }
      const key = this.key();
      this.skipTrivia();
      if (key === INCOMPLETE || this.done) {
        this.cut = true;
        return result;
      }
      if (this.text[this.pos] !== ":") throw new SyntaxProblem("expected a colon");
      this.pos += 1;
      const value = this.value(depth + 1);
      if (value === INCOMPLETE) {
        this.cut = true;
        return result;
      }
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (this.cut) return result;
    }
  }

  private array(depth: number): unknown[] {
    this.pos += 1;
    const result: unknown[] = [];
    for (;;) {
      this.skipTrivia();
      const char = this.text[this.pos];
      if (char === undefined) {
        this.cut = true;
        return result;
      }
      if (char === "]") {
        this.pos += 1;
        return result;
      }
      if (char === "}") return result;
      if (char === ",") {
        this.pos += 1;
        continue;
      }
      const value = this.value(depth + 1);
      if (value === INCOMPLETE) this.cut = true;
      if (this.cut) return result;
      result.push(value);
    }
  }

  private key(): string | typeof INCOMPLETE {
    const char = this.text[this.pos];
    if (char === '"' || char === "'") return this.string(char, true);
    const bare = /^[A-Za-z_$][\w$-]*/.exec(this.text.slice(this.pos, this.pos + 200))?.[0];
    if (bare === undefined) throw new SyntaxProblem("expected a key");
    this.pos += bare.length;
    if (this.done) return INCOMPLETE;
    const next = this.text[this.pos];
    if (next === '"' || next === "'") this.pos += 1;
    return bare;
  }

  private closesString(at: number, asKey: boolean): boolean {
    let index = at + 1;
    while (index < this.text.length && /\s/.test(this.text[index] ?? "")) index += 1;
    const next = this.text[index];
    if (next === undefined) return true;
    if (asKey) return next === ":";
    if (VALUE_TERMINATORS.has(next)) return true;
    return index > at + 1 && (next === '"' || next === "'");
  }

  private string(quote: string, asKey: boolean): string | typeof INCOMPLETE {
    this.pos += 1;
    let out = "";
    for (;;) {
      const char = this.text[this.pos];
      if (char === undefined) return INCOMPLETE;
      if (char === "\\") {
        const next = this.text[this.pos + 1];
        if (next === undefined) return INCOMPLETE;
        if (next === "u") {
          const hex = this.text.slice(this.pos + 2, this.pos + 6);
          if (hex.length < 4 && this.pos + 2 + hex.length >= this.text.length) return INCOMPLETE;
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.pos += 6;
            continue;
          }
        }
        out += ESCAPES[next] ?? next;
        this.pos += 2;
        continue;
      }
      if (char === quote && this.closesString(this.pos, asKey)) {
        this.pos += 1;
        return out;
      }
      out += char;
      this.pos += 1;
    }
  }

  private number(): number | typeof INCOMPLETE {
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.text.slice(this.pos, this.pos + 64),
    )?.[0];
    if (match === undefined) {
      if (this.pos + 1 >= this.text.length) return INCOMPLETE;
      throw new SyntaxProblem("bad number");
    }
    this.pos += match.length;
    return this.done ? INCOMPLETE : Number(match);
  }

  private word(): unknown {
    const word = /^[A-Za-z]+/.exec(this.text.slice(this.pos, this.pos + 16))?.[0] ?? "";
    const lower = word.toLowerCase();
    this.pos += word.length;
    if (lower in WORDS) return WORDS[lower];
    if (this.done && Object.keys(WORDS).some((known) => known.startsWith(lower))) return INCOMPLETE;
    throw new SyntaxProblem(`unknown word ${word}`);
  }
}

function parseStrict(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

interface Candidate {
  value: unknown;
  span: number;
  truncated: boolean;
}

function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  let from = 0;
  for (let attempt = 0; attempt < MAX_STARTS; attempt += 1) {
    const offset = text.slice(from).search(/[{[]/);
    if (offset === -1) break;
    const start = from + offset;
    const parser = new TolerantParser(text, start);
    try {
      const value = parser.value(0);
      found.push({ value, span: parser.pos - start, truncated: parser.cut });
      if (parser.cut) break;
      from = parser.pos;
    } catch (error) {
      if (!(error instanceof SyntaxProblem)) throw error;
      from = start + 1;
    }
  }
  return found;
}

export function readJson(text: string): JsonReading {
  const trimmed = text.trim();
  const strict = parseStrict(trimmed);
  if (strict !== undefined)
    return { ok: true, value: strict.value, truncated: false, repaired: false };
  const best = candidates(trimmed).sort((a, b) => b.span - a.span)[0];
  if (best === undefined) return { ok: false, truncated: false };
  if (best.truncated && isEmptyContainer(best.value)) return { ok: false, truncated: true };
  return { ok: true, value: best.value, truncated: best.truncated, repaired: true };
}

const MIN_OVERLAP_CHARS = 6;
const MAX_OVERLAP_CHARS = 400;

export function joinContinuation(partial: string, reply: string): string {
  const continuation = reply.replace(/^\s*```(?:json)?[ \t]*\n?/i, "").replace(/\s*```\s*$/, "");
  const limit = Math.min(partial.length, continuation.length, MAX_OVERLAP_CHARS);
  for (let size = limit; size >= MIN_OVERLAP_CHARS; size -= 1)
    if (partial.endsWith(continuation.slice(0, size))) return partial + continuation.slice(size);
  return partial + continuation;
}
