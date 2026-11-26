import { describe, expect, it } from "vitest";

import { placePopover, POPOVER_GAP, VIEWPORT_MARGIN } from "./popover-position";

const desktop = { width: 1280, height: 800 };
const phone = { width: 411, height: 914 };
const popover = { width: 288, height: 120 };

function anchorAt(left: number, top: number) {
  return { left, right: left + 16, top, bottom: top + 16 };
}

function popoverLeft(anchor: ReturnType<typeof anchorAt>, shift: number): number {
  return (anchor.left + anchor.right) / 2 - popover.width / 2 + shift;
}

describe("placePopover", () => {
  it("keeps a centred popover in place when it fits", () => {
    expect(placePopover(anchorAt(600, 400), popover, desktop)).toEqual({
      shift: 0,
      side: "top",
    });
  });

  it("shifts left near the right edge so the popover stays inside the viewport", () => {
    const anchor = anchorAt(1250, 400);
    const { shift } = placePopover(anchor, popover, desktop);
    expect(shift).toBeLessThan(0);
    expect(popoverLeft(anchor, shift) + popover.width).toBe(desktop.width - VIEWPORT_MARGIN);
  });

  it("shifts right near the left edge", () => {
    const anchor = anchorAt(10, 400);
    const { shift } = placePopover(anchor, popover, phone);
    expect(shift).toBeGreaterThan(0);
    expect(popoverLeft(anchor, shift)).toBe(VIEWPORT_MARGIN);
  });

  it("flips below the anchor when there is no room above", () => {
    expect(placePopover(anchorAt(200, 40), popover, phone).side).toBe("bottom");
    expect(
      placePopover(anchorAt(200, popover.height + POPOVER_GAP + VIEWPORT_MARGIN), popover, phone)
        .side,
    ).toBe("top");
  });

  it("takes the roomier side when neither side fits", () => {
    const tall = { width: 288, height: 400 };
    const short = { width: 411, height: 300 };
    expect(placePopover(anchorAt(200, 200), tall, short).side).toBe("top");
    expect(placePopover(anchorAt(200, 60), tall, short).side).toBe("bottom");
  });

  it("pins a popover wider than the viewport to the left margin", () => {
    const anchor = anchorAt(300, 400);
    const wide = { width: 500, height: 100 };
    const { shift } = placePopover(anchor, wide, phone);
    expect((anchor.left + anchor.right) / 2 - wide.width / 2 + shift).toBe(VIEWPORT_MARGIN);
  });
});
