import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { useFluidHover, useRegisterFluidHoverItem } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import type { SearchResult } from "@/lib/backend";
import { FileIcon } from "@/components/file-icon";

interface SearchResultsProps {
  results: SearchResult[];
  /** Highlighted row, driven by the keyboard (ArrowUp/Down) or the pointer. */
  activeIndex: number | null;
  onActiveIndexChange: (index: number | null) => void;
  onOpen: (result: SearchResult, reveal: boolean) => void;
  /** CSS pixels; the list scrolls beyond it. */
  maxHeight: number;
}

/** The folder part of a path, trimmed to its last two folders, e.g. Documents\Resumes. */
export function parentOf(path: string) {
  const i = path.lastIndexOf("\\", path.length - 2);
  const parent = i <= 2 ? path.slice(0, i + 1) : path.slice(0, i);
  const parts = parent.split("\\").filter(Boolean);
  if (parts.length <= 2) return parent;
  return parts.slice(-2).join("\\");
}

/** Rows drawn at first, and added each time the list nears its end. The
 *  results setting goes up to 500, and every row is an icon, two lines of
 *  text and a hover target to measure. */
const ROWS_PER_PAGE = 100;

/** Px from the bottom of what's drawn at which scrolling draws more. */
const DRAW_AHEAD_PX = 200;

export function SearchResults({ results, activeIndex, onActiveIndexChange, onOpen, maxHeight }: SearchResultsProps) {
  const shape = useShape();
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef);
  const { handlers, registerItem } = hover;

  // New results start from the top again. Rows only ever get added until
  // then, so the hover never loses a row it measured.
  const [drawn, setDrawn] = useState({ results, count: ROWS_PER_PAGE });
  const count = drawn.results === results ? drawn.count : ROWS_PER_PAGE;
  const drawMore = (atLeast = 0) => {
    const next = Math.min(results.length, Math.max(count + ROWS_PER_PAGE, atLeast));
    if (next > count) setDrawn({ results, count: next });
  };
  // The keyboard can move past what's drawn (ArrowUp from the top wraps to
  // the last row).
  if (activeIndex !== null && activeIndex >= count - 1 && count < results.length) {
    drawMore(activeIndex + ROWS_PER_PAGE);
  }

  // One-way only: the parent's selection drives the highlight, and the hook
  // reports rows the pointer moves onto. Writing the selection back into the
  // hook looped forever with the pointer resting on the list: new results
  // reset the selection, the hook re-picked the row under the pointer, and
  // so on. The hook also re-picks after re-measuring rows, so only report
  // what follows an actual mouse move.
  const lastPointerMove = useRef(0);
  useEffect(() => {
    if (hover.activeIndex === null || performance.now() - lastPointerMove.current > 100) return;
    onActiveIndexChange(hover.activeIndex);
  }, [hover.activeIndex, onActiveIndexChange]);

  // New results (another query, or a type filter) fade in rather than swap in
  // place. Opacity only: the list's size is the window's to change.
  useEffect(() => {
    const list = listRef.current;
    if (!list || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    list.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }, [results]);

  useEffect(() => {
    if (activeIndex === null) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Search results"
      onMouseEnter={handlers.onMouseEnter}
      onMouseMove={(e) => {
        lastPointerMove.current = performance.now();
        handlers.onMouseMove(e);
      }}
      onClick={handlers.onClick}
      onScroll={(e) => {
        const list = e.currentTarget;
        if (list.scrollTop + list.clientHeight >= list.scrollHeight - DRAW_AHEAD_PX) drawMore();
      }}
      className="relative flex flex-col overflow-y-auto p-1.5"
      style={{ maxHeight }}
    >
      <FluidHoverHighlight hover={{ ...hover, activeIndex }} className={cn(shape.bg, "bg-white/10")} />
      {results.slice(0, count).map((r, i) => (
        <ResultRow
          key={r.id}
          result={r}
          index={i}
          active={i === activeIndex}
          registerItem={registerItem}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

interface ResultRowProps {
  result: SearchResult;
  index: number;
  active: boolean;
  registerItem: (index: number, element: HTMLElement | null) => void;
  onOpen: (result: SearchResult, reveal: boolean) => void;
}

function ResultRow({ result, index, active, registerItem, onOpen }: ResultRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);

  return (
    <div
      ref={ref}
      data-index={index}
      role="option"
      aria-selected={active}
      title={result.path}
      onClick={(e) => onOpen(result, e.ctrlKey)}
      className="relative flex h-9 shrink-0 cursor-pointer items-center gap-2 px-2"
    >
      <FileIcon result={result} size={18} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("truncate text-[12px] leading-4 transition-colors duration-80", active ? "text-white" : "text-zinc-200")}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {result.name.replace(/\.lnk$/i, "")}
        </span>
        <span className="truncate text-[10px] leading-3 text-zinc-500">
          {result.type === "app" ? "App" : parentOf(result.path)}
        </span>
      </div>
    </div>
  );
}
