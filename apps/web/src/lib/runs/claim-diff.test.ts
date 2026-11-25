import { describe, expect, it } from "vitest";

import {
  claimSimilarity,
  type ClaimRef,
  diffClaims,
  normaliseClaim,
  summariseClaimDiff,
} from "./claim-diff";

const claim = (section: string, text: string): ClaimRef => ({ section, text });

describe("normaliseClaim", () => {
  it("ignores case, punctuation, citation markers and spacing", () => {
    expect(normaliseClaim("Acme sells  Widgets, to SMBs! [S1, S2]")).toBe(
      "acme sells widgets to smbs",
    );
    expect(normaliseClaim("Ünïcode café")).toBe("ünïcode café");
  });
});

describe("claimSimilarity", () => {
  it("is token Jaccard on normalised text", () => {
    expect(claimSimilarity("a b c d", "a b c d")).toBe(1);
    expect(claimSimilarity("a b c d", "a b c e")).toBeCloseTo(3 / 5);
    expect(claimSimilarity("a b", "c d")).toBe(0);
    expect(claimSimilarity("", "")).toBe(1);
  });
});

describe("diffClaims", () => {
  it("classifies unchanged, changed, added and removed claims within a section", () => {
    const a = [
      claim("Offering", "Acme sells invoicing software to small businesses."),
      claim("Offering", "Acme was founded in 2012 in Berlin."),
      claim("Offering", "Acme has an open API."),
    ];
    const b = [
      claim("Offering", "acme sells invoicing software to small businesses"),
      claim("Offering", "Acme was founded in 2014 in Berlin."),
      claim("Offering", "Acme offers a mobile app for receipts."),
    ];
    const changes = diffClaims(a, b);
    expect(changes.map((change) => change.kind)).toEqual([
      "unchanged",
      "changed",
      "added",
      "removed",
    ]);
    const changed = changes[1];
    expect(changed?.kind === "changed" && changed.a.text).toBe(
      "Acme was founded in 2012 in Berlin.",
    );
    expect(summariseClaimDiff(changes)).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
  });

  it("never matches claims across sections", () => {
    const changes = diffClaims(
      [claim("Customers", "Acme serves retailers")],
      [claim("Market", "Acme serves retailers")],
    );
    expect(changes.map((change) => `${change.kind}:${change.section}`)).toEqual([
      "removed:Customers",
      "added:Market",
    ]);
  });

  it("pairs each claim at most once, preferring the most similar", () => {
    const a = [claim("S", "red blue green yellow"), claim("S", "red blue green yellow purple")];
    const b = [claim("S", "red blue green yellow purple orange")];
    const changes = diffClaims(a, b);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.kind === "changed" && changes[0].a.text).toBe(
      "red blue green yellow purple",
    );
    expect(changes[1]?.kind).toBe("removed");
  });

  it("treats duplicate texts one to one and respects the threshold", () => {
    const twice = diffClaims([claim("S", "x y")], [claim("S", "x y"), claim("S", "x y")]);
    expect(twice.map((change) => change.kind)).toEqual(["unchanged", "added"]);
    const loose = diffClaims([claim("S", "a b c d")], [claim("S", "a b e f")]);
    expect(loose.map((change) => change.kind)).toEqual(["added", "removed"]);
    const lowered = diffClaims([claim("S", "a b c d")], [claim("S", "a b e f")], 0.3);
    expect(lowered.map((change) => change.kind)).toEqual(["changed"]);
  });

  it("returns nothing for two empty briefs", () => {
    expect(diffClaims([], [])).toEqual([]);
  });
});
