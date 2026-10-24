import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GlobeSimpleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { useFluidHover, useRegisterFluidHoverItem } from "@/hooks/use-fluid-hover";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import type { WebResult } from "@/lib/web-search";

interface WebResultsProps {
  results: WebResult[];
  /** Highlighted row, driven by the keyboard (ArrowUp/Down) or the pointer. */
  activeIndex: number | null;
  onActiveIndexChange: (index: number | null) => void;
  onOpen: (result: WebResult) => void;
  /** CSS pixels; the list scrolls beyond it. */
  maxHeight: number;
}

/** "github.com" for https://www.github.com/a/b. */
function siteOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Favicon data URLs by site (null: it has none). Promises are cached so
// results from the same site share one lookup.
const favicons = new Map<string, Promise<string | null>>();

function loadFavicon(url: string) {
  let site: string;
  try {
    site = new URL(url).origin;
  } catch {
    return Promise.resolve(null);
  }
  let icon = favicons.get(site);
  if (!icon) {
    icon = invoke<string | null>("favicon", { url }).catch(() => null);
    favicons.set(site, icon);
  }
  return icon;
}

/** The site's favicon, or a globe until (or unless) it loads. */
function Favicon({ url, size }: { url: string; size: number }) {
  const [loaded, setLoaded] = useState<{ url: string; icon: string | null } | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setBroken(false);
    loadFavicon(url).then((icon) => {
      if (!cancelled) setLoaded({ url, icon });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const icon = loaded?.url === url && !broken ? loaded.icon : null;
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setBroken(true)}
        className="shrink-0 rounded-[3px] object-contain"
      />
    );
  }
  return <GlobeSimpleIcon size={size} className="shrink-0 text-zinc-400" />;
}

/** A search provider's results, in the file results' look (search-results.tsx). */
export function WebResults({ results, activeIndex, onActiveIndexChange, onOpen, maxHeight }: WebResultsProps) {
  const shape = useShape();
  const listRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(listRef);
  const { handlers, registerItem } = hover;

  // As in SearchResults: only a real mouse move reports the row under the
  // pointer, so new results don't loop with the hook.
  const lastPointerMove = useRef(0);
  useEffect(() => {
    if (hover.activeIndex === null || performance.now() - lastPointerMove.current > 100) return;
    onActiveIndexChange(hover.activeIndex);
  }, [hover.activeIndex, onActiveIndexChange]);

  useEffect(() => {
    if (activeIndex === null) return;
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Web results"
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
        <WebRow
          key={r.url}
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

function WebRow({
  result,
  index,
  active,
  registerItem,
  onOpen,
}: {
  result: WebResult;
  index: number;
  active: boolean;
  registerItem: (index: number, element: HTMLElement | null) => void;
  onOpen: (result: WebResult) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);

  return (
    <div
      ref={ref}
      data-index={index}
      role="option"
      aria-selected={active}
      title={result.snippet ? `${result.url}\n\n${result.snippet}` : result.url}
      onClick={() => onOpen(result)}
      className="relative flex h-9 shrink-0 cursor-pointer items-center gap-2 px-2"
    >
      <Favicon url={result.url} size={18} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-[12px] leading-4 transition-colors duration-80",
            active ? "text-white" : "text-zinc-200"
          )}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {result.title}
        </span>
        <span className="truncate text-[10px] leading-3 text-zinc-500">
          <span className="text-zinc-400">{siteOf(result.url)}</span>
          {result.snippet && <> · {result.snippet}</>}
        </span>
      </div>
    </div>
  );
}
