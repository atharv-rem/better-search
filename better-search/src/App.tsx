import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MemoryIcon, TimerIcon } from "@phosphor-icons/react";
import { InputMessage } from "@/components/ui/input-message";
import { SearchResults } from "@/components/search-results";
import { TypeFilter } from "@/components/type-filter";
import { countGroups, groupOf, type FileGroup } from "@/lib/file-groups";
import { backend, BackendError, type IndexProgress, type SearchResult } from "@/lib/backend";

type IndexState =
  | { kind: "checking" }
  | { kind: "needs-permission"; denied: boolean }
  | { kind: "asking" } // UAC prompt is open
  | { kind: "indexing"; progress?: IndexProgress }
  | { kind: "ready" }
  | { kind: "error"; message: string };

const SEARCH_DEBOUNCE_MS = 100;

// Kept within the frame's 24px padding: the window ends where the frame does,
// so a wider shadow would be clipped.
const panelShadow = "0 0 0 1px rgb(255 255 255 / 0.1), 0 4px 10px rgb(0 0 0 / 0.5), 0 10px 22px rgb(0 0 0 / 0.45)";

/** The results list's height limit, in CSS pixels. The window's top sits a
 *  quarter of the way down the screen (lib.rs `place_search`) and grows
 *  downwards, so the list gets what's left above the taskbar after the bar,
 *  gaps and padding (~170px). With Windows text scaling a 420px list can
 *  otherwise run off the bottom of the screen. */
function resultsMaxHeight() {
  const below = screen.availHeight - screen.height * 0.25 - 170;
  return Math.max(120, Math.min(420, Math.floor(below)));
}

function hideWindow() {
  return invoke("hide_window").catch(() => getCurrentWindow().hide());
}

/** App memory (shell, webview and backend), refreshed while the window is open. */
function useMemoryUsage() {
  const [mb, setMb] = useState<number | null>(null);
  useEffect(() => {
    const poll = () =>
      invoke<number>("memory_usage")
        // A failed reading (0) keeps the last value rather than blanking it.
        .then((bytes) => bytes > 0 && setMb(Math.round(bytes / 1048576)))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  return mb;
}

function App() {
  const memoryMb = useMemoryUsage();
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [typeFilter, setTypeFilter] = useState<FileGroup | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [index, setIndex] = useState<IndexState>({ kind: "checking" });
  const [shownAt, setShownAt] = useState(0); // bumps on every Alt+S
  const searchRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const indexRef = useRef(index);
  indexRef.current = index;

  const ready = index.kind === "ready";

  const groups = useMemo(() => countGroups(results), [results]);
  // A new search may have no results of the chosen type: show everything then.
  const activeFilter = typeFilter && groups.some((g) => g.id === typeFilter) ? typeFilter : null;
  const visible = useMemo(
    () => (activeFilter ? results.filter((r) => groupOf(r) === activeFilter) : results),
    [results, activeFilter]
  );

  // Fit the window to the search box and results as they change.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => {
      // In physical pixels: Windows text scaling zooms the page, so CSS
      // pixels aren't the window's logical pixels.
      const { width, height } = frame.getBoundingClientRect();
      const ratio = window.devicePixelRatio;
      invoke("resize_window", {
        width: Math.ceil(width * ratio),
        height: Math.ceil(height * ratio),
      }).catch(() => {});
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // Clicking another app closes the search, as nothing covers the screen
  // any more. Not while the UAC prompt (which takes focus) is open. Only
  // blur is handled: a new window opens already focused and never reports
  // gaining focus. A blur can arrive late: the page is suspended while hidden
  // and only handles it after the next Alt+S has shown the window again, so
  // check the window really is unfocused before hiding it.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (focused || indexRef.current.kind === "asking") return;
      win
        .isFocused()
        .then((now) => (now ? undefined : hideWindow()))
        .catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Window shown (Alt+S): focus the search bar and ask the freshly started
  // backend whether the index exists yet. Rust sends "search-shown" on every
  // show; focus events alone miss it when the webview still counts as focused.
  useEffect(() => {
    const focusSearch = () => searchRef.current?.querySelector("textarea")?.focus();
    focusSearch();
    // When the window is destroyed on close, each Alt+S loads a fresh page
    // that missed "search-shown": the page loading *is* the window showing.
    setShownAt(Date.now());

    const unlistenShown = listen("search-shown", () => {
      focusSearch();
      // A hidden window comes back with the last query: select it so typing
      // starts a new search.
      searchRef.current?.querySelector("textarea")?.select();
      setShownAt(Date.now());
    });
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) focusSearch();
    });

    return () => {
      unlistenShown.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!shownAt) return;
    backend
      .status()
      .then((s) => {
        setIndex((prev) => {
          if (prev.kind === "asking") return prev;
          if (s.indexing) return prev.kind === "indexing" ? prev : { kind: "indexing" };
          if (s.indexed_at === 0) return { kind: "needs-permission", denied: prev.kind === "needs-permission" && prev.denied };
          return { kind: "ready" };
        });
      })
      .catch(() => {}); // backend stopped (window hidden again)
  }, [shownAt]);

  useEffect(
    () =>
      backend.onEvent((e) => {
        if (e.type === "index_progress") setIndex({ kind: "indexing", progress: e.progress });
        else if (e.type === "index_done") setIndex({ kind: "ready" });
        else setIndex({ kind: "error", message: e.error });
      }),
    []
  );

  // Search as you type, once typing pauses for SEARCH_DEBOUNCE_MS. Only the
  // newest request's answer is shown.
  useEffect(() => {
    const seq = ++searchSeq.current;
    if (!ready || !query.trim()) {
      setSearchMs(null);
      setResults([]);
      setActiveIndex(null);
      return;
    }
    const timer = setTimeout(() => {
      const started = performance.now();
      backend
        .search(query)
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setSearchMs(Math.max(1, Math.round(performance.now() - started)));
          setResults(r);
          setActiveIndex(r.length ? 0 : null);
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, ready, shownAt]);

  const openResult = useCallback(async (r: SearchResult, reveal: boolean) => {
    // Record the open before hiding: hiding stops the backend.
    await Promise.race([backend.markOpened(r.id).catch(() => {}), new Promise((ok) => setTimeout(ok, 300))]);
    try {
      await invoke("open_result", { path: r.path, reveal });
    } catch (err) {
      console.error("Failed to open:", err);
      return;
    }
    await hideWindow();
  }, []);

  const requestPermission = useCallback(async () => {
    setIndex({ kind: "asking" });
    // Step out of the way of the UAC prompt.
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(false).catch(() => {});
    try {
      await backend.reindex();
      setIndex((prev) => (prev.kind === "asking" ? { kind: "indexing" } : prev));
    } catch (err) {
      if (err instanceof BackendError && err.code === "admin_denied") {
        setIndex({ kind: "needs-permission", denied: true });
      } else if (err instanceof BackendError && err.code === "busy") {
        setIndex({ kind: "indexing" });
      } else {
        setIndex({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      await win.setAlwaysOnTop(true).catch(() => {});
      await win.setFocus().catch(() => {});
    }
  }, []);

  // Results keyboard: runs in the capture phase so InputMessage never sees
  // these keys (its Enter would "send" and clear the box).
  const handleKeyDownCapture = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!visible.length) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => (i === null ? 0 : (i + step + visible.length) % visible.length));
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const r = visible[activeIndex ?? 0];
      if (r) openResult(r, e.ctrlKey);
    }
  };

  // Hide window when pressing Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideWindow().catch((err) => console.error("Failed to hide window:", err));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const showResults = ready && results.length > 0;
  const showPanel = showResults || (index.kind !== "ready" && index.kind !== "checking");

  return (
    // The window is sized to this frame (see the resize effect), not the
    // screen; the padding is room for the shadow.
    <div ref={frameRef} className="dark relative w-fit p-6 select-none">
      {/* In the top padding, out of the layout: appearing or changing never
          resizes the window or moves the bar. */}
      {(memoryMb !== null || searchMs !== null) && (
        <div className="absolute top-0.5 right-6 flex items-center gap-2.5 rounded-md bg-black px-2 py-0.5 text-[10px] leading-3 font-medium text-zinc-200 tabular-nums" style={{ boxShadow: "0 0 0 1px rgb(255 255 255 / 0.1)" }}>
          {searchMs !== null && (
            <span className="flex items-center gap-1">
              <TimerIcon size={11} />
              {searchMs} ms
            </span>
          )}
          {memoryMb !== null && (
            <span className="flex items-center gap-1">
              <MemoryIcon size={11} />
              {memoryMb} MB
            </span>
          )}
        </div>
      )}
      <div className="w-110" onKeyDownCapture={handleKeyDownCapture}>
        <InputMessage
          ref={searchRef}
          size="compact"
          maxRows={4}
          value={query}
          onValueChange={setQuery}
          placeholder="what should i look for you?"
          className="gap-0! bg-black! p-[5px]! text-white"
          style={{ boxShadow: panelShadow }}
          textareaProps={{ className: "placeholder:text-zinc-400!" }}
        />

        {showResults && groups.length > 1 && (
          <TypeFilter
            groups={groups}
            total={results.length}
            selected={activeFilter}
            onSelect={(g) => {
              setTypeFilter(g);
              setActiveIndex(0);
            }}
          />
        )}

        {showPanel && (
          // Below the bar; the window grows downwards, so the bar never moves.
          <div
            className="mt-2 overflow-hidden rounded-xl bg-black text-white"
            style={{ boxShadow: panelShadow }}
          >
            {showResults ? (
              <SearchResults
                results={visible}
                activeIndex={activeIndex}
                onActiveIndexChange={setActiveIndex}
                onOpen={openResult}
                maxHeight={resultsMaxHeight()}
              />
            ) : (
              <IndexPanel state={index} onAllow={requestPermission} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function IndexPanel({ state, onAllow }: { state: IndexState; onAllow: () => void }) {
  if (state.kind === "needs-permission" || state.kind === "asking") {
    const denied = state.kind === "needs-permission" && state.denied;
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] leading-4 font-semibold">Index your drives</span>
          <span className="text-[12px] leading-4 text-zinc-400">
            {denied
              ? "Permission was declined. Search can't find anything until your drives are indexed."
              : "Better Search reads your drives' file list once so every search is instant. Windows will ask for administrator permission."}
          </span>
        </div>
        <button
          type="button"
          onClick={onAllow}
          disabled={state.kind === "asking"}
          className="self-start rounded-lg bg-white px-3 py-1.5 text-[12px] font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {state.kind === "asking" ? "Waiting for permission…" : denied ? "Try again" : "Allow and index"}
        </button>
      </div>
    );
  }

  if (state.kind === "indexing") {
    const p = state.progress;
    const pct = p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
    return (
      <div className="flex flex-col gap-2 p-4">
        <span className="text-[12px] leading-4 text-zinc-300">
          {p ? `${p.phase === "reading" ? "Reading" : "Saving"} ${p.drive}…` : "Indexing your drives…"}
          {pct !== null && <span className="text-zinc-500"> {pct}%</span>}
        </span>
        <div className="h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-white transition-[width] duration-300"
            style={{ width: pct === null ? "10%" : `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col gap-3 p-4">
        <span className="text-[12px] leading-4 text-zinc-400">Indexing failed: {state.message}</span>
        <button
          type="button"
          onClick={onAllow}
          className="self-start rounded-lg bg-white px-3 py-1.5 text-[12px] font-semibold text-black transition-opacity hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return null;
}

export default App;
