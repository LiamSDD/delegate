"use client";

import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

import { placePopover, type PopoverPlacement } from "@/lib/popover-position";

const CENTRED: PopoverPlacement = { shift: 0, side: "top" };

export function usePopoverPlacement(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
): { side: PopoverPlacement["side"]; style: CSSProperties } {
  const [placement, setPlacement] = useState<PopoverPlacement>(CENTRED);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = anchor.current?.getBoundingClientRect();
      const panel = popover.current;
      if (box === undefined || panel === null) return;
      setPlacement(
        placePopover(
          box,
          { width: panel.offsetWidth, height: panel.offsetHeight },
          { width: document.documentElement.clientWidth, height: window.innerHeight },
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true });
    };
  }, [open, anchor, popover]);

  const active = open ? placement : CENTRED;
  return {
    side: active.side,
    style: active.shift === 0 ? {} : { left: `calc(50% + ${String(active.shift)}px)` },
  };
}
