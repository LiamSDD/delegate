import { describe, expect, it } from "vitest";

import { createRunEmitter } from "../agent/emitter";
import { RunEventSchema, type RunEventDraft } from "../events";
import { ibanValid, luhnValid, redactEventDraft, redactPii } from "./redact";

describe("redactPii", () => {
  it.each([
    ["Write to jane.doe+press@example.co.uk today", "Write to [redacted:email] today"],
    ["Call +44 20 7946 0958.", "Call [redacted:phone]."],
    ["US office +1 (415) 555-2671", "US office [redacted:phone]"],
    ["Paris +33 1 23 45 67 89", "Paris [redacted:phone]"],
    ["Berlin +49 30 1234567", "Berlin [redacted:phone]"],
    ["Tokyo +81-3-1234-5678", "Tokyo [redacted:phone]"],
    ["Front desk (415) 555-2671", "Front desk [redacted:phone]"],
    ["London 020 7946 0958", "London [redacted:phone]"],
    ["Support 415-555-2671", "Support [redacted:phone]"],
    ["Card 4111 1111 1111 1111 on file", "Card [redacted:card] on file"],
    ["Card 5500-0000-0000-0004", "Card [redacted:card]"],
    ["Amex 378282246310005", "Amex [redacted:card]"],
    ["IBAN GB82 WEST 1234 5698 7654 32", "IBAN [redacted:iban]"],
    ["IBAN DE89370400440532013000.", "IBAN [redacted:iban]."],
    ["Call 415 555 2671 today", "Call [redacted:phone] today"],
    ["Call 415.555.2671 today", "Call [redacted:phone] today"],
    ["Toll free 1-800-555-0199.", "Toll free [redacted:phone]."],
    ["Toll free 1 (800) 555-0199", "Toll free [redacted:phone]"],
    ["IBAN de89 3704 0044 0532 0130 00 on file", "IBAN [redacted:iban] on file"],
    ["IBAN gb82west12345698765432", "IBAN [redacted:iban]"],
  ])("redacts %s", (input, expected) => {
    const result = redactPii(input);
    expect(result.text).toBe(expected);
    expect(result.count).toBe(1);
  });

  it.each([
    "Released v2.14.3 on 2026-11-25",
    "Founded in 1998; revenue grew 12% in 2024/2025",
    "Priced at $1,299.00 or €12 345 678 per year",
    "Blocked fetch to 169.254.169.254: link-local address",
    "Denied: 10.0.0.1 and 192.168.100.200 are private ranges",
    "Resolved to 2001:db8::1 which is reserved",
    "Order 4111 1111 1111 1112 failed the Luhn check",
    "Timestamp 1764057600000 ms",
    "Build 20261125.1 shipped",
    "Retina asset logo@2x.png",
    "ISBN 978-3-16-148410-0",
    "Range 1200-1450 employees",
    "Account GB00 WEST 1234 5698 7654 32 has a bad checksum",
    "HTTP 429 after 30000 ms; retry-after 60",
    "Shipped 100 200 3000 units across 3 regions",
    "Serial 123.456.7890 is retired",
    "Ticket ab12 cdef 3456 7890 closed",
    "Release 1.800.555.0199.4 is out",
  ])("leaves %s alone", (input) => {
    expect(redactPii(input)).toEqual({ text: input, count: 0 });
  });

  it("counts every redaction in a mixed string", () => {
    const result = redactPii("a@b.io, c@d.io and +44 20 7946 0958");
    expect(result.count).toBe(3);
    expect(result.text).not.toMatch(/@|7946/);
  });

  it("validates checksums", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB83WEST12345698765432")).toBe(false);
    expect(ibanValid("gb82 west 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("XX82WEST12345698765432")).toBe(false);
  });
});

describe("redactEventDraft", () => {
  const runId = "run_1";

  it("redacts tool output and errors and records only the count", () => {
    const draft: RunEventDraft = {
      runId,
      stepId: "s1",
      type: "tool.result",
      payload: {
        toolCallId: "tc1",
        tool: "fetch_page",
        ok: false,
        summary: "Contact page lists press@example.com",
        durationMs: 10,
        error: "upstream said: call +1 (415) 555-2671",
      },
    };
    const redacted = redactEventDraft(draft);
    expect(redacted.payload).toMatchObject({
      summary: "Contact page lists [redacted:email]",
      error: "upstream said: call [redacted:phone]",
      redactions: 2,
    });
    expect(JSON.stringify(redacted)).not.toContain("press@example.com");
    expect(
      RunEventSchema.parse({ ...redacted, seq: 1, at: "2026-11-25T00:00:00.000Z" }).payload,
    ).toMatchObject({ redactions: 2 });
  });

  it("leaves clean events, policy IPs and citation-bearing artifacts untouched", () => {
    const policy: RunEventDraft = {
      runId,
      type: "policy.decided",
      payload: {
        tool: "fetch_page",
        decision: "deny",
        policyId: "egress",
        reason: "169.254.169.254 is a metadata address",
      },
    };
    expect(redactEventDraft(policy)).toEqual(policy);
    const artifact: RunEventDraft = {
      runId,
      type: "artifact.created",
      payload: {
        artifactId: "a1",
        kind: "source-snapshot",
        title: "Contact",
        version: 1,
        content: { url: "https://example.com/contact", text: "Email press@example.com" },
      },
    };
    expect(redactEventDraft(artifact)).toBe(artifact);
  });

  it("redacts run failure messages", () => {
    const redacted = redactEventDraft({
      runId,
      type: "run.failed",
      payload: { error: { code: "runtime_error", message: "bad input from ops@example.org" } },
    });
    expect(redacted.payload).toEqual({
      error: { code: "runtime_error", message: "bad input from [redacted:email]" },
      redactions: 1,
    });
  });

  it("is applied by the run emitter before delivery", async () => {
    const delivered: RunEventDraft[] = [];
    const emitter = createRunEmitter((event) => {
      delivered.push(event);
      return Promise.resolve();
    });
    await emitter.emit({
      runId,
      type: "run.failed",
      payload: { error: { code: "x", message: "card 4111 1111 1111 1111" } },
    });
    expect(delivered[0]?.payload).toEqual({
      error: { code: "x", message: "card [redacted:card]" },
      redactions: 1,
    });
  });
});
