import { describe, expect, it } from "vitest";

import { classifyAddress, isIpLiteral, parseIPv4, parseIPv6 } from "./ip";

describe("parseIPv4", () => {
  it.each([
    ["127.0.0.1", 0x7f000001],
    ["127.1", 0x7f000001],
    ["0x7f.1", 0x7f000001],
    ["2130706433", 0x7f000001],
    ["0177.0.0.1", 0x7f000001],
    ["10.1.2", 0x0a010002],
    ["8.8.8.8", 0x08080808],
  ])("parses %s", (input, expected) => {
    expect(parseIPv4(input)).toBe(expected);
  });

  it.each(["256.0.0.1", "1.2.3.4.5", "example.com", "", "1..2", "0x", "08.0.0.1"])(
    "rejects %s",
    (input) => {
      expect(parseIPv4(input)).toBeNull();
    },
  );
});

describe("parseIPv6", () => {
  it("parses compressed, full and IPv4-tailed forms", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("[::ffff:127.0.0.1]")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("2606:4700::1111")).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111]);
  });

  it.each(["1::2::3", "12345::", "fe80::1%eth0", "1:2:3:4:5:6:7:8:9", "g::1"])(
    "rejects %s",
    (input) => {
      expect(parseIPv6(input)).toBeNull();
    },
  );
});

describe("classifyAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.254",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(classifyAddress(address).allowed).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows public %s", (address) => {
    expect(classifyAddress(address)).toEqual({ allowed: true });
  });

  it("names the range it blocked", () => {
    expect(classifyAddress("169.254.169.254")).toEqual({ allowed: false, range: "link-local" });
    expect(classifyAddress("100.64.1.1")).toEqual({ allowed: false, range: "cgnat" });
  });
});

describe("isIpLiteral", () => {
  it.each(["127.1", "2130706433", "[::1]", "::1", "8.8.8.8"])("treats %s as a literal", (host) => {
    expect(isIpLiteral(host)).toBe(true);
  });

  it.each(["example.com", "1password.com", "a.b.c.d"])("treats %s as a name", (host) => {
    expect(isIpLiteral(host)).toBe(false);
  });
});
