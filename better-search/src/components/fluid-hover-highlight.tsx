import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { UseFluidHoverReturn } from "@/hooks/use-fluid-hover";

// ---------------------------------------------------------------------------
// The one hover highlight every fluid hover list renders: an absolutely
// positioned fill that slides between the rects `useFluidHover` measures.
//
//   const hover = useFluidHover(ref);
//   <FluidHoverHighlight hover={hover} className={shape.bg} />
//
// CSS transitions rather than an animation library: a 80ms slide and fade
// don't need springs, and the library was the biggest part of the bundle.
// The container must be `relative`; radius and colour are the consumer's.
// ---------------------------------------------------------------------------

/** What the highlight reads off the hook. */
export type FluidHoverSource = Pick<UseFluidHoverReturn, "activeIndex" | "itemRects" | "isMeasured" | "session">;

const EASE = "80ms cubic-bezier(0.25, 1, 0.5, 1)";
const SLIDE = `transform ${EASE}, width ${EASE}, height ${EASE}, opacity ${EASE}`;

export function FluidHoverHighlight({ hover, className }: { hover: FluidHoverSource; className?: string }) {
  const { activeIndex, itemRects, isMeasured, session } = hover;
  const rect = isMeasured && activeIndex !== null ? (itemRects[activeIndex] ?? null) : null;
  const ref = useRef<HTMLDivElement>(null);
  // The session the highlight is showing, or null while hidden.
  const shownSession = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!rect) {
      el.style.transition = "opacity 60ms";
      el.style.opacity = "0";
      shownSession.current = null;
      return;
    }
    const place = () => {
      el.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
    };
    if (shownSession.current === session) {
      el.style.transition = matchMedia("(prefers-reduced-motion: reduce)").matches ? "none" : SLIDE;
      place();
      return;
    }
    // Appearing, or the pointer just entered the list: fade in where it
    // lands instead of sliding over from wherever it was last.
    el.style.transition = "none";
    el.style.opacity = "0";
    place();
    void el.offsetWidth; // apply the jump before the fade starts
    el.style.transition = "opacity 80ms";
    el.style.opacity = "1";
    shownSession.current = session;
  }, [rect?.left, rect?.top, rect?.width, rect?.height, session]);

  return (
    <div
      ref={ref}
      data-slot="fluid-hover-highlight"
      className={cn("pointer-events-none absolute top-0 left-0 bg-hover opacity-0", className)}
    />
  );
}
