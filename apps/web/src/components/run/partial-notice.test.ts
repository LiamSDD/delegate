import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PartialNotice } from "./partial-notice";

describe("PartialNotice", () => {
  it("renders nothing for a complete deliverable", () => {
    expect(renderToStaticMarkup(createElement(PartialNotice, { partial: undefined }))).toBe("");
  });

  it("says the result is partial and lists skipped steps", () => {
    const html = renderToStaticMarkup(
      createElement(PartialNotice, {
        partial: { reason: "Stopped at the 230 s deadline.", skippedSteps: ["research_topic"] },
      }),
    );
    expect(html).toContain("Partial result.");
    expect(html).toContain("Stopped at the 230 s deadline.");
    expect(html).toContain("Skipped: research_topic.");
  });
});
