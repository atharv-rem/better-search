import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { useFluidHover, useRegisterFluidHoverItem } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import type { SearchResult } from "@/lib/backend";
import { iconOf } from "@/lib/file-icons";

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
function parentOf(path: string) {
  const i = path.lastIndexOf("\\", path.length - 2);
  const parent = i <= 2 ? path.slice(0, i + 1) : path.slice(0, i);
  const parts = parent.split("\\").filter(Boolean);
  if (parts.length <= 2) return parent;
  return parts.slice(-2).join("\\");
}

export function SearchResults({ results, activeIndex, onActiveIndexChange, onOpen, maxHeight }: SearchResultsProps) {
  const shape = useShape();
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef);
  const { handlers, registerItem } = hover;

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
      className="relative flex flex-col overflow-y-auto p-1.5"
      style={{ maxHeight }}
    >
      <FluidHoverHighlight hover={{ ...hover, activeIndex }} className={cn(shape.bg, "bg-white/10")} />
      {results.map((r, i) => (
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
  const { Icon, color } = iconOf(result);

  return (
    <div
      ref={ref}
      data-index={index}
      role="option"
      aria-selected={active}
      title={result.path}
      onClick={(e) => onOpen(result, e.ctrlKey)}
      className="relative flex h-11 shrink-0 cursor-pointer items-center gap-2.5 px-2.5"
    >
      <Icon size={24} weight="duotone" color={color} className="shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn("truncate text-[13px] leading-4 transition-colors duration-80", active ? "text-white" : "text-zinc-200")}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {result.name}
        </span>
        <span className="truncate text-[11px] leading-3.5 text-zinc-500">{parentOf(result.path)}</span>
      </div>
    </div>
  );
}
