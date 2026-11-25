export const CHUNK_DEFAULTS = {
  targetTokens: 800,
  maxTokens: 900,
  overlapTokens: 100,
  minTokensBeforeHeadingBreak: 120,
  charsPerToken: 4,
} as const;

export interface PageChunk {
  ordinal: number;
  heading?: string;
  text: string;
  tokenCount: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHUNK_DEFAULTS.charsPerToken);
}

interface Block {
  text: string;
  headingLevel?: number;
  headingText?: string;
}

function blocksOf(text: string): Block[] {
  return text
    .split(/\n{2,}/)
    .map((raw) => raw.trim())
    .filter((raw) => raw !== "")
    .map((raw) => {
      const heading = /^(#{1,6})\s+(.+)$/.exec(raw.split("\n")[0] ?? "");
      return heading === null
        ? { text: raw }
        : {
            text: raw,
            headingLevel: heading[1]?.length ?? 1,
            headingText: (heading[2] ?? "").trim().slice(0, 200),
          };
    });
}

function splitOversized(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const breakAt = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const cut = breakAt > maxChars / 2 ? breakAt + 1 : maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== "") pieces.push(rest);
  return pieces;
}

function overlapTail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const tail = text.slice(-chars);
  const space = tail.indexOf(" ");
  return space === -1 ? tail : tail.slice(space + 1);
}

export function chunkPage(text: string, options: Partial<typeof CHUNK_DEFAULTS> = {}): PageChunk[] {
  const settings = { ...CHUNK_DEFAULTS, ...options };
  const targetChars = settings.targetTokens * settings.charsPerToken;
  const maxChars = settings.maxTokens * settings.charsPerToken;
  const overlapChars = settings.overlapTokens * settings.charsPerToken;
  const blocks = blocksOf(text).flatMap((block): Block[] =>
    block.text.length <= targetChars
      ? [block]
      : splitOversized(block.text, targetChars - overlapChars).map((piece, index) =>
          index === 0 ? { ...block, text: piece } : { text: piece },
        ),
  );
  const chunks: PageChunk[] = [];
  let parts: string[] = [];
  let heading: string | undefined;
  let chunkHeading: string | undefined;
  let fresh = 0;
  const length = () => parts.join("\n\n").length;
  const flush = () => {
    if (fresh === 0) return;
    const body = parts.join("\n\n").slice(0, maxChars);
    chunks.push({
      ordinal: chunks.length,
      ...(chunkHeading === undefined ? {} : { heading: chunkHeading }),
      text: body,
      tokenCount: estimateTokens(body),
    });
    parts = [overlapTail(body, overlapChars)];
    fresh = 0;
    chunkHeading = heading;
  };
  for (const block of blocks) {
    const topHeading = block.headingLevel !== undefined && block.headingLevel <= 2;
    if (block.headingText !== undefined) heading = block.headingText;
    if (topHeading && length() >= settings.minTokensBeforeHeadingBreak * settings.charsPerToken) {
      flush();
      parts = [];
    }
    if (length() + block.text.length + 2 > targetChars) flush();
    if (fresh === 0) chunkHeading = heading;
    if (topHeading && fresh === 0) parts = [];
    parts.push(block.text);
    fresh += 1;
  }
  flush();
  return chunks;
}
