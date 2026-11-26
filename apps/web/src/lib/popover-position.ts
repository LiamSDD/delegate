export const VIEWPORT_MARGIN = 8;
export const POPOVER_GAP = 6;

export interface AnchorBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PopoverPlacement {
  shift: number;
  side: "top" | "bottom";
}

export function placePopover(
  anchor: AnchorBox,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
): PopoverPlacement {
  const centred = (anchor.left + anchor.right) / 2 - popover.width / 2;
  const maxLeft = viewport.width - VIEWPORT_MARGIN - popover.width;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(centred, maxLeft));
  const needed = popover.height + POPOVER_GAP + VIEWPORT_MARGIN;
  const above = anchor.top;
  const below = viewport.height - anchor.bottom;
  const side = above >= needed || (below < needed && above >= below) ? "top" : "bottom";
  return { shift: left - centred, side };
}
