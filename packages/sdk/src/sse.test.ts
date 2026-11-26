import { describe, expect, it } from "vitest";

import { type SseMessage, parseSse } from "./sse";

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: readonly string[]): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of parseSse(streamOf(chunks))) messages.push(message);
  return messages;
}

describe("parseSse", () => {
  it("reads id, event and data and skips comments and retry lines", async () => {
    expect(
      await collect([
        'retry: 2000\n\n: heartbeat\n\nid: 3\nevent: step.started\ndata: {"seq":3}\n\n',
      ]),
    ).toEqual([{ id: "3", event: "step.started", data: '{"seq":3}' }]);
  });

  it("joins multi-line data and keeps the last id for later messages", async () => {
    expect(await collect(["id: 1\ndata: a\ndata: b\n\ndata: c\n\n"])).toEqual([
      { id: "1", event: "", data: "a\nb" },
      { id: "1", event: "", data: "c" },
    ]);
  });

  it("handles CRLF and messages split at any byte, even inside a line ending", async () => {
    const text = 'id: 7\r\nevent: run.completed\r\ndata: {"ok":true}\r\n\r\n';
    for (let cut = 1; cut < text.length; cut += 1)
      expect(await collect([text.slice(0, cut), text.slice(cut)]), String(cut)).toEqual([
        { id: "7", event: "run.completed", data: '{"ok":true}' },
      ]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: café ✓\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 9));
        controller.enqueue(bytes.slice(9, 11));
        controller.enqueue(bytes.slice(11));
        controller.close();
      },
    });
    const messages: SseMessage[] = [];
    for await (const message of parseSse(stream)) messages.push(message);
    expect(messages).toEqual([{ id: null, event: "", data: "café ✓" }]);
  });

  it("drops an unterminated trailing message, as the specification requires", async () => {
    expect(await collect(["data: complete\n\ndata: cut off"])).toEqual([
      { id: null, event: "", data: "complete" },
    ]);
  });

  it("releases the stream when the consumer stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: tick\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const message of parseSse(stream)) {
      expect(message.data).toBe("tick");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
