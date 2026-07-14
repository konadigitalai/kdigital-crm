"use client";

// A dropdown panel that escapes its container.
//
// Why this exists: the leads toolbar scrolls horizontally when it fills up
// (rather than wrapping onto a second line). A horizontal scroller means
// `overflow-x: auto` — and CSS won't let you pair that with `overflow-y:
// visible`; the moment one axis is not `visible`, the other computes to `auto`
// too. So an `absolute`-positioned dropdown inside the toolbar gets clipped by
// the scroller instead of overflowing it.
//
// The fix is to take the panel out of the flow entirely: portal it to
// <body> and position it `fixed`, measured from its anchor's viewport rect.
// Nothing above it can clip it, and it tracks the anchor when anything scrolls.
//
// Dismissal: callers keep their existing "mousedown anywhere else closes me"
// listeners on window/document. Those still work — the panel stops mousedown
// from propagating past <body>, so a click *inside* the panel never reaches
// them, while a click outside does. That's also why the caller's
// `ref.current.contains(target)` check doesn't need to know about the portal.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

/** Gap between the anchor and the panel, and the minimum breathing room we
 *  keep against the viewport edges. */
const GAP = 4;
const MARGIN = 8;

export function AnchoredPopover({
  anchor,
  align = "left",
  className,
  children,
}: {
  /** The element the panel hangs off — usually the wrapper the caller already
   *  holds a ref to for outside-click detection. */
  anchor: HTMLElement | null;
  /** Which edge of the anchor the panel lines up with. */
  align?: "left" | "right";
  className?: string;
  children: React.ReactNode;
}) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!anchor) return;

    function place() {
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const w = panel?.offsetWidth ?? 0;
      const h = panel?.offsetHeight ?? 0;

      let left = align === "right" ? a.right - w : a.left;
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));

      // Flip above the anchor when there isn't room below it — a long Rating
      // list opened from a toolbar near the bottom of the window would
      // otherwise run off the screen.
      const below = a.bottom + GAP;
      const fitsBelow = below + h <= window.innerHeight - MARGIN;
      const fitsAbove = a.top - h - GAP >= MARGIN;
      const top = !fitsBelow && fitsAbove ? a.top - h - GAP : below;

      setPos({ top, left });
    }

    place();
    // Capture phase, so the panel also follows the anchor when an *ancestor*
    // scrolls — specifically the toolbar's own horizontal scroller, whose
    // scroll events don't bubble to window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, align, panel]);

  if (typeof document === "undefined" || !anchor) return null;

  return createPortal(
    <div
      ref={setPanel}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0 }}
      className={cn(
        "fixed z-50 overflow-hidden rounded-lg border border-rule bg-paper py-1 shadow-card",
        // Hidden until measured, so it never paints for a frame at the wrong
        // spot and jumps.
        pos ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
