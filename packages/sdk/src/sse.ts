export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

function nextLine(buffer: string, final: boolean): { line: string; rest: string } | null {
  const index = buffer.search(/[\r\n]/);
  if (index === -1) return final && buffer !== "" ? { line: buffer, rest: "" } : null;
  if (buffer[index] === "\r") {
    if (index === buffer.length - 1 && !final) return null;
    const skip = buffer[index + 1] === "\n" ? 2 : 1;
    return { line: buffer.slice(0, index), rest: buffer.slice(index + skip) };
  }
  return { line: buffer.slice(0, index), rest: buffer.slice(index + 1) };
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | null = null;
  let event = "";
  let data: string[] = [];
  const dispatch = (): SseMessage | null => {
    const message = data.length === 0 ? null : { id, event, data: data.join("\n") };
    event = "";
    data = [];
    return message;
  };
  const consume = function* (final: boolean): Generator<SseMessage> {
    for (;;) {
      const next = nextLine(buffer, final);
      if (next === null) return;
      buffer = next.rest;
      const line = next.line;
      if (line === "") {
        const message = dispatch();
        if (message !== null) yield message;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const raw = colon === -1 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
      else if (field === "id" && !value.includes("\0")) id = value;
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      yield* consume(false);
    }
    buffer += decoder.decode();
    yield* consume(true);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
