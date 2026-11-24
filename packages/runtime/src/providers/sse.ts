export interface SseMessage {
  event: string | undefined;
  data: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const takeLine = (final: boolean): string | undefined => {
    const match = /\r\n|\r|\n/.exec(buffer);
    if (match === null) {
      if (!final || buffer === "") return undefined;
      const rest = buffer;
      buffer = "";
      return rest;
    }
    if (!final && match[0] === "\r" && match.index === buffer.length - 1) return undefined;
    const line = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    return line;
  };

  const handleLine = (line: string): SseMessage | undefined => {
    if (line === "") {
      const message = data.length > 0 ? { event, data: data.join("\n") } : undefined;
      event = undefined;
      data = [];
      return message;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const content = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "data") data.push(content);
    else if (field === "event") event = content;
    return undefined;
  };

  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (let line = takeLine(done); line !== undefined; line = takeLine(done)) {
        const message = handleLine(line);
        if (message !== undefined) yield message;
      }
    }
    const last = handleLine("");
    if (last !== undefined) yield last;
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
