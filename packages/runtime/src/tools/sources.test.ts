import { describe, expect, it } from "vitest";

import { SourceStore } from "./sources";

const at = "2026-11-25T10:00:00.000Z";

describe("SourceStore", () => {
  it("restores documents under their original ids and numbers new ones after the highest", () => {
    const store = new SourceStore();
    for (const sourceId of ["S1", "S4"])
      store.restore({
        record: {
          sourceId,
          url: `https://acme.example/${sourceId}`,
          title: sourceId,
          fetchedAt: at,
          kind: "company_site",
        },
        text: `text ${sourceId}`,
        hiddenText: [],
      });
    expect(store.get("S4")?.text).toBe("text S4");
    expect(store.has("https://acme.example/S1")).toBe(true);
    const added = store.add({
      url: "https://acme.example/new",
      title: "New",
      kind: "company_site",
      fetchedAt: at,
      text: "fresh",
    });
    expect(added.document.record.sourceId).toBe("S5");
    store.restore({ ...added.document, text: "ignored" });
    expect(store.get("S5")?.text).toBe("fresh");
  });
});
