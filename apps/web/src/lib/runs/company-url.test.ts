import { describe, expect, it } from "vitest";

import { normaliseCompanyUrl } from "./company-url";

describe("normaliseCompanyUrl", () => {
  it.each([
    ["acme.com", "https://acme.com/", "acme.com"],
    ["  https://www.Acme.com/pricing?ref=x#top ", "https://www.acme.com/", "acme.com"],
    ["http://shop.acme.co.uk/", "https://shop.acme.co.uk/", "shop.acme.co.uk"],
    ["xn--bcher-kva.example", "https://xn--bcher-kva.example/", "xn--bcher-kva.example"],
  ])("normalises %s to the https homepage", (raw, url, domain) => {
    expect(normaliseCompanyUrl(raw)).toEqual({ ok: true, url, domain });
  });

  it.each([
    ["", "empty"],
    ["127.0.0.1", "ip_literal"],
    ["http://10.0.0.1/admin", "ip_literal"],
    ["[::1]", "ip_literal"],
    ["http://[::ffff:127.0.0.1]/", "ip_literal"],
    ["0x7f.1", "ip_literal"],
    ["localhost", "local_host"],
    ["http://app.localhost", "local_host"],
    ["printer.local", "local_host"],
    ["db.internal", "local_host"],
    ["1.0.0.127.in-addr.arpa", "local_host"],
    ["intranet", "invalid"],
    ["ftp://acme.com", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["https://user:pass@acme.com", "credentials"],
    ["acme.com:8443", "port"],
    ["acme .com", "invalid"],
    [`${"a".repeat(2100)}.com`, "too_long"],
  ])("rejects %s (%s)", (raw, reason) => {
    expect(normaliseCompanyUrl(raw)).toEqual({ ok: false, reason });
  });
});
