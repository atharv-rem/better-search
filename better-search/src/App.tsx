import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CaretDownIcon, CheckIcon, ClockCounterClockwiseIcon, GearSixIcon } from "@/lib/phosphor";
import { GlobalSearchIcon } from "@/components/global-search-icon";
import { RamIcon, TimeIcon } from "@/components/stat-icons";
import { BrowserIcon, DEFAULT_BROWSER, useInstalledBrowsers } from "@/components/browser-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { SearchBox } from "@/components/search-box";
import { PreviewPanel } from "@/components/preview-panel";
import { SearchResults } from "@/components/search-results";
import { WebResults } from "@/components/web-results";
import { TypeFilter } from "@/components/type-filter";
import { countGroups, groupOf, type FileGroup } from "@/lib/file-groups";
import { Shortcut } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { backend, BackendError, type IndexProgress, type SearchResult } from "@/lib/backend";
import { DEFAULT_SETTINGS, saveSettings, useSettings, webSearchUrl, type Settings } from "@/lib/settings";
import { providerOf, webSearch, type WebResult } from "@/lib/web-search";

type IndexState =
  | { kind: "checking" }
  | { kind: "needs-permission"; denied: boolean }
  | { kind: "asking" } // UAC prompt is open
  | { kind: "indexing"; progress?: IndexProgress }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/** A web search with the user's search provider, for the query it was for. */
type WebState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | { kind: "done"; query: string; results: WebResult[] }
  | { kind: "error"; query: string; message: string };

const SEARCH_DEBOUNCE_MS = 100;

/** Recent searches listed: file searches under the empty search box, web
 *  searches ("/ cats") under the web-search row while only "/" is typed. */
const RECENT_SHOWN = 5;

/** "/ cats" searches the web for "cats"; null for an ordinary file search. */
function webQueryOf(query: string) {
  return query.startsWith("/") ? query.slice(1).trim() : null;
}

/** Every icon in the web-search row and its browser menu, in pixels. */
const ROW_ICON_SIZE = 16;

/** Height of one menu item (16px line with py-1), for sizing the window. */
const BROWSER_ITEM_HEIGHT = 24;

/** The web-search row (p-3 around a 16px line), above a provider's results. */
const WEB_ROW_HEIGHT = 40;

function searchWeb(web: Settings["web"], text: string, browser: string) {
  return invoke("open_url", { url: webSearchUrl(web, text), browser }).then(() => hideWindow());
}

// Kept within the frame's 24px padding: the window ends where the frame does,
// so a wider shadow would be clipped.
const panelShadow = "0 0 0 1px rgb(255 255 255 / 0.1), 0 4px 10px rgb(0 0 0 / 0.5), 0 10px 22px rgb(0 0 0 / 0.45)";

/** The search-time and memory pills just above the bar: same padding, same
 *  height. */
const statPill = "flex h-5 items-center gap-1 rounded-md bg-black px-2";
const statPillShadow = "0 0 0 1px rgb(255 255 255 / 0.1)";

/** The square preview above the bar, in CSS pixels. Fixed, so moving between
 *  results never resizes the window. */
const PREVIEW_SIZE = 112;

// The layout around the bar, in CSS pixels, for centring it all on screen.
/** From the top of the row above the bar (the preview, with the stat pills at
 *  its bottom right) to the bar, including the 8px gap below the row. */
const ABOVE_BAR = PREVIEW_SIZE + 8;
/** The bar with one line typed. */
const BAR_HEIGHT = 72;
/** From the bar's bottom to the results list's top: the type filter row (mt-1.5,
 *  p-0.5 and 22px pills) and the panel's mt-2. */
const BAR_TO_RESULTS = 32 + 8;
/** A result row (search-results.tsx h-9) and the list's p-1.5 top and bottom. */
const RESULT_ROW = 36;
const RESULTS_PADDING = 12;
/** Space kept clear of the screen's top and bottom edges. */
const SCREEN_MARGIN = 24;

/** Rows the results list shows before it scrolls. */
const RESULT_ROWS = 6;

/** The results list's height limit: RESULT_ROWS rows, or fewer whole rows if
 *  the screen can't fit them, so the last one is never cut in half. */
function resultsMaxHeight() {
  const room = screen.availHeight - 2 * SCREEN_MARGIN - ABOVE_BAR - BAR_HEIGHT - BAR_TO_RESULTS;
  const rows = Math.min(RESULT_ROWS, Math.floor((room - RESULTS_PADDING) / RESULT_ROW));
  return Math.max(3, rows) * RESULT_ROW + RESULTS_PADDING;
}

/** Where the bar's top sits on screen: wherever centres everything at its
 *  fullest (pills, preview, bar, filters and a full results list) between
 *  the top of the screen and the taskbar. lib.rs `place_search` puts it
 *  there, so it stays put as results come and go. */
function barScreenTop() {
  const block = ABOVE_BAR + BAR_HEIGHT + BAR_TO_RESULTS + resultsMaxHeight();
  return Math.max(SCREEN_MARGIN, (screen.availHeight - block) / 2) + ABOVE_BAR;
}

/** Physical pixels the preview's thumbnails are fitted within. Twice the
 *  preview, as the thumbnail is cropped to fill the square. */
function previewThumbSize() {
  return Math.min(1024, Math.round(PREVIEW_SIZE * 2 * window.devicePixelRatio));
}

function hideWindow() {
  return invoke("hide_window").catch(() => getCurrentWindow().hide());
}

/** App memory (shell, webview and backend), refreshed while the window is open.
 *  Null on every show until the first fresh reading: the number from before
 *  the window was hidden is stale (the webview was trimmed and resumed since). */
function useMemoryUsage(shownAt: number) {
  const [mb, setMb] = useState<number | null>(null);
  useEffect(() => {
    setMb(null);
    const poll = () =>
      invoke<number>("memory_usage")
        // A failed reading (0) keeps the last value rather than blanking it.
        .then((bytes) => bytes > 0 && setMb(Math.round(bytes / 1048576)))
        .catch(() => {});
    let timer: ReturnType<typeof setInterval>;
    // Let the resumed webview settle before the first reading.
    const first = setTimeout(() => {
      poll();
      timer = setInterval(poll, 3000);
    }, 1200);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [shownAt]);
  return mb;
}

function App() {
  const [shownAt, setShownAt] = useState(0); // bumps on every Alt+S
  const memoryMb = useMemoryUsage(shownAt);
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [typeFilter, setTypeFilter] = useState<FileGroup | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [index, setIndex] = useState<IndexState>({ kind: "checking" });
  const settings = useSettings() ?? DEFAULT_SETTINGS;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const queryRef = useRef(query);
  queryRef.current = query;
  // Newest first; read again on every show (the settings page may have
  // cleared them).
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    invoke<string[]>("recent_searches")
      .then(setRecent)
      .catch(() => {});
  }, [shownAt]);

  /** Keeps `text` as a recent search: called once something came of it. */
  const remember = useCallback((text: string) => {
    let t = text.trim();
    // "/cats" and "/ cats" are the same web search.
    if (t.startsWith("/")) t = `/${t.slice(1).trim()}`;
    if (!t || t === "/" || !settingsRef.current.search.remember_recent) return;
    setRecent((r) => [t, ...r.filter((q) => q !== t)]);
    invoke("add_recent_search", { query: t }).catch(() => {});
  }, []);
  const { max_results: maxResults, enter_reveals: enterReveals, show_preview: showPreview } = settings.search;
  const browsers = useInstalledBrowsers(shownAt);
  // Local too, so Tab can cycle faster than the save comes back.
  const [savedBrowser, setSavedBrowser] = useState(settings.web.browser);
  useEffect(() => setSavedBrowser(settings.web.browser), [settings.web.browser]);
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false);
  // A browser that has since been uninstalled falls back to the default.
  const browser = browsers.find((b) => b.id === savedBrowser) ?? DEFAULT_BROWSER;
  const searchRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const indexRef = useRef(index);
  indexRef.current = index;

  const ready = index.kind === "ready";
  const webQuery = webQueryOf(query);
  const rememberRecent = settings.search.remember_recent;
  const recentFiles = useMemo(() => recent.filter((q) => !q.startsWith("/")).slice(0, RECENT_SHOWN), [recent]);
  const recentWeb = useMemo(() => recent.filter((q) => q.startsWith("/")).slice(0, RECENT_SHOWN), [recent]);
  // Listed while only "/" is typed; ArrowDown moves into the list.
  const showRecentWeb = rememberRecent && webQuery === "" && recentWeb.length > 0;
  const [recentWebActive, setRecentWebActive] = useState<number | null>(null);
  useEffect(() => {
    if (!showRecentWeb) setRecentWebActive(null);
  }, [showRecentWeb]);
  // File searches are listed the same way, in a panel under the empty box.
  const showRecentFiles = ready && rememberRecent && query === "" && recentFiles.length > 0;
  const [recentFilesActive, setRecentFilesActive] = useState<number | null>(null);
  useEffect(() => {
    if (!showRecentFiles) setRecentFilesActive(null);
  }, [showRecentFiles]);
  // With a provider, web searches show their results here; without, they open
  // in the browser.
  const provider = providerOf(settings.web.provider);
  const [webState, setWebState] = useState<WebState>({ kind: "idle" });
  const [webActive, setWebActive] = useState<number | null>(null);
  const webSeq = useRef(0);
  // Results are for the query they were searched with; typing on hides them.
  const webShown = provider && webState.kind !== "idle" && webState.query === webQuery ? webState : null;
  const webResults = webShown?.kind === "done" ? webShown.results : [];

  const groups = useMemo(() => countGroups(results), [results]);
  // A new search may have no results of the chosen type: show everything then.
  const activeFilter = typeFilter && groups.some((g) => g.id === typeFilter) ? typeFilter : null;
  const visible = useMemo(
    () => (activeFilter ? results.filter((r) => groupOf(r) === activeFilter) : results),
    [results, activeFilter]
  );

  // Fit the window to the preview, search box and results as they change.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => {
      // In physical pixels: Windows text scaling zooms the page, so CSS
      // pixels aren't the window's logical pixels.
      const { width, height, top } = frame.getBoundingClientRect();
      const barTop = (searchRef.current?.getBoundingClientRect().top ?? top) - top;
      const ratio = window.devicePixelRatio;
      invoke("resize_window", {
        width: Math.ceil(width * ratio),
        height: Math.ceil(height * ratio),
        // Rust keeps the bar in place, so the preview grows the window upwards.
        barTop: Math.round(barTop * ratio),
        barScreenTop: Math.round(barScreenTop() * ratio),
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

  // Window shown (Alt+S): focus the search bar and ask the backend whether
  // the index exists yet. Rust sends "search-shown" on every
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
      // starts a new search, or clear it if the settings say so.
      if (settingsRef.current.search.clear_on_close) setQuery("");
      else searchRef.current?.querySelector("textarea")?.select();
      setShownAt(Date.now());
    });
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) focusSearch();
    });
    // Loaded and listening: the hidden window may now be suspended.
    unlistenShown.then(() => invoke("search_ready")).catch(() => {});

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
      .catch(() => {}); // backend exited; Rust restarts it on the next show
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
    if (!ready || !query.trim() || webQueryOf(query) !== null) {
      setSearchMs(null);
      setResults([]);
      setActiveIndex(null);
      return;
    }
    const timer = setTimeout(() => {
      const started = performance.now();
      backend
        .search(query, maxResults)
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setSearchMs(Math.max(1, Math.round(performance.now() - started)));
          setResults(r);
          setActiveIndex(r.length ? 0 : null);
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, ready, shownAt, maxResults]);

  const openResult = useCallback(async (r: SearchResult, reveal: boolean) => {
    remember(queryRef.current);
    // Recorded for ranking without waiting: hiding only trims the backend,
    // which still answers it.
    backend.markOpened(r.id).catch(() => {});
    try {
      await invoke("open_result", { path: r.path, reveal });
    } catch (err) {
      console.error("Failed to open:", err);
      return;
    }
    await hideWindow();
  }, [remember]);

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

  // Only on Enter, not as you type: every search uses the user's credits.
  const searchProvider = (text: string) => {
    if (!provider || !text) return;
    const seq = ++webSeq.current;
    setWebState({ kind: "loading", query: text });
    webSearch(provider.id, text)
      .then((results) => {
        if (seq !== webSeq.current) return;
        setWebState({ kind: "done", query: text, results });
        setWebActive(results.length ? 0 : null);
      })
      .catch((err: Error) => seq === webSeq.current && setWebState({ kind: "error", query: text, message: err.message }));
  };

  /** Runs a recent web search again, as Enter on it would. */
  const runRecentWeb = (text: string) => {
    const q = webQueryOf(text);
    if (!q) return;
    setQuery(text);
    remember(text);
    if (provider) searchProvider(q);
    else searchWeb(settings.web, q, browser.id).catch((err) => console.error("Failed to open browser:", err));
  };

  /** Fills a recent file search into the box, which searches it. */
  const runRecentFile = (text: string) => {
    setQuery(text);
    searchRef.current?.querySelector("textarea")?.focus();
  };

  const openWebResult = (r: WebResult) =>
    invoke("open_url", { url: r.url, browser: browser.id })
      .then(() => hideWindow())
      .catch((err) => console.error("Failed to open browser:", err));

  const chooseBrowser = (id: string) => {
    setSavedBrowser(id);
    const s = settingsRef.current;
    saveSettings({ ...s, web: { ...s.web, browser: id } }).catch((err) => console.error("Failed to save browser:", err));
  };

  // Results keyboard: runs in the capture phase so InputMessage never sees
  // these keys (its Enter would "send" and clear the box).
  const handleKeyDownCapture = (e: ReactKeyboardEvent) => {
    // The browser menu renders in a portal, but its keys bubble through here.
    if ((e.target as HTMLElement).closest('[data-slot="dropdown-menu-content"]')) return;
    if (query === "" && e.key !== "Tab") {
      // The recent searches listed under the empty box: ArrowDown enters the
      // list, ArrowUp walks back up and out (with nothing highlighted it
      // still recalls history), Enter runs the highlighted one and Escape
      // drops the highlight.
      if (!showRecentFiles || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setRecentFilesActive((i) => (i === null ? 0 : Math.min(i + 1, recentFiles.length - 1)));
      } else if (recentFilesActive !== null && (e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowUp") setRecentFilesActive(recentFilesActive === 0 ? null : recentFilesActive - 1);
        else if (e.key === "Enter") runRecentFile(recentFiles[recentFilesActive]);
        else setRecentFilesActive(null);
      }
      return;
    }
    if (webQuery !== null) {
      if (e.key === "Tab") {
        // Cycle the browser to search in; Shift+Tab goes back.
        e.preventDefault();
        e.stopPropagation();
        const at = browsers.findIndex((b) => b.id === browser.id);
        const step = e.shiftKey ? -1 : 1;
        chooseBrowser(browsers[(at + step + browsers.length) % browsers.length].id);
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && showRecentWeb) {
        // Like the empty box's list: ArrowDown enters and walks down,
        // ArrowUp walks back up and out.
        e.preventDefault();
        e.stopPropagation();
        setRecentWebActive((i) =>
          e.key === "ArrowDown"
            ? i === null
              ? 0
              : Math.min(i + 1, recentWeb.length - 1)
            : i === null || i === 0
              ? null
              : i - 1
        );
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && webResults.length) {
        e.preventDefault();
        e.stopPropagation();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setWebActive((i) => (i === null ? 0 : (i + step + webResults.length) % webResults.length));
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        submit(e.ctrlKey);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!visible.length) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => (i === null ? 0 : (i + step + visible.length) % visible.length));
    } else if (e.key === "Tab") {
      // Cycle the type pills (All, then each group); Shift+Tab goes back.
      e.preventDefault();
      e.stopPropagation();
      if (groups.length < 2) return;
      const order: (FileGroup | null)[] = [null, ...groups.map((g) => g.id)];
      const step = e.shiftKey ? -1 : 1;
      const at = order.indexOf(activeFilter);
      setTypeFilter(order[(at + step + order.length) % order.length]);
      setActiveIndex(0);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit(e.ctrlKey);
    }
  };

  /** Enter, or the bar's arrow button: opens the highlighted result, or runs
   *  the web search. `ctrl` is Ctrl+Enter (or Ctrl+click). */
  const submit = (ctrl: boolean) => {
    if (webQuery !== null) {
      if (!webQuery) {
        if (showRecentWeb && recentWebActive !== null) runRecentWeb(recentWeb[recentWebActive]);
        return;
      }
      remember(query);
      // Ctrl+Enter searches in the browser even with a provider.
      if (!provider || ctrl) {
        searchWeb(settings.web, webQuery, browser.id).catch((err) => console.error("Failed to open browser:", err));
      } else if (webResults.length) {
        openWebResult(webResults[webActive ?? 0]);
      } else if (webShown?.kind !== "loading") {
        searchProvider(webQuery);
      }
      return;
    }
    const r = visible[activeIndex ?? 0];
    if (r) openResult(r, ctrl !== enterReveals);
  };

  // Hide window when pressing Escape (an open menu takes it first)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) hideWindow().catch((err) => console.error("Failed to hide window:", err));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const showResults = ready && results.length > 0;
  const showPanel = webQuery !== null || showResults || showRecentFiles || (index.kind !== "ready" && index.kind !== "checking");

  return (
    // The window is sized to this frame (see the resize effect), not the
    // screen; the padding is room for the shadow.
    <div ref={frameRef} className="dark relative w-fit p-6 select-none">
      <div className="w-110" onKeyDownCapture={handleKeyDownCapture}>
        {/* The row above the bar: the preview on the left, the stat pills on
            the right. Both sit on the row's bottom, so the pills stay just
            above the bar whether the preview is there or not. */}
        <div className="mb-2 flex items-end justify-between gap-2">
          {showResults && visible.length > 0 && showPreview && (
            // Its space is kept for as long as there are results (the square
            // fades out for ones with nothing to preview), so the window only
            // grows upwards once rather than as the preview comes and goes.
            <PreviewPanel
              result={visible[Math.min(activeIndex ?? 0, visible.length - 1)]}
              size={PREVIEW_SIZE}
              thumbSize={previewThumbSize()}
              style={{ boxShadow: panelShadow }}
            />
          )}
          {/* ml-auto: stays right when there's no preview to its left. */}
          <div className="ml-auto flex items-center gap-1.5 text-[10px] leading-3 font-medium text-zinc-200 tabular-nums">
            {searchMs !== null && (
              <span className={cn(statPill, "motion-safe:animate-fade-in")} style={{ boxShadow: statPillShadow }}>
                <TimeIcon size={11} />
                {searchMs} ms
              </span>
            )}
            <span className={statPill} style={{ boxShadow: statPillShadow }}>
              <RamIcon size={11} />
              {memoryMb === null ? (
                <span className="h-2 w-8 animate-pulse rounded-sm bg-white/15" role="status" aria-label="Reading memory usage" />
              ) : (
                <>{memoryMb} MB</>
              )}
            </span>
          </div>
        </div>
        <SearchBox
          ref={searchRef}
          maxRows={4}
          value={query}
          onValueChange={setQuery}
          placeholder="what should i look for you?"
          className="gap-0! bg-black! p-[5px]! text-white"
          style={{ boxShadow: panelShadow }}
          textareaClassName="placeholder:text-zinc-400!"
          onSubmit={submit}
          rightSlot={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Settings"
              onClick={() => invoke("open_settings").catch((err) => console.error("Failed to open settings:", err))}
            >
              <GearSixIcon size={16} />
            </Button>
          }
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
            // Rises in when it first appears (results, the web search row or
            // the indexing panel); transform only, so the window resizes once.
            className="mt-2 origin-top overflow-hidden rounded-xl bg-black text-white motion-safe:animate-rise-in"
            style={{ boxShadow: panelShadow }}
          >
            {webQuery !== null ? (
              <>
                <div className="flex items-center gap-2 pr-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!webQuery) return;
                      remember(query);
                      if (provider) searchProvider(webQuery);
                      else searchWeb(settings.web, webQuery, browser.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 p-3 pr-0 text-left text-[12px] leading-4"
                  >
                    <GlobalSearchIcon size={ROW_ICON_SIZE} className="shrink-0" />
                    <span className="truncate">
                      {!webQuery
                        ? "Type something to search the web"
                        : provider
                          ? `Search ${provider.name} for “${webQuery}”`
                          : `Search the web for “${webQuery}”`}
                    </span>
                  </button>
                  <DropdownMenu onOpenChange={setBrowserMenuOpen}>
                    <DropdownMenuTrigger
                      className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-[12px] leading-4 text-white outline-hidden transition-colors hover:bg-white/10 focus-visible:bg-white/10 data-[state=open]:bg-white/10"
                      aria-label="Browser to search in"
                    >
                      <BrowserIcon browser={browser} size={ROW_ICON_SIZE} />
                      <span className="max-w-28 truncate">{browser.name}</span>
                      <CaretDownIcon size={ROW_ICON_SIZE} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      side="bottom"
                      align="end"
                      // The window is only as tall as the frame (see the spacer
                      // below), so don't let the menu flip up while it catches up.
                      avoidCollisions={false}
                      className="dark border-white/10 bg-zinc-950 text-white"
                      // Hand focus back to the search box, not the trigger.
                      onCloseAutoFocus={(e) => {
                        e.preventDefault();
                        searchRef.current?.querySelector("textarea")?.focus();
                      }}
                    >
                      {browsers.map((b) => (
                        <DropdownMenuItem
                          key={b.id}
                          className="gap-2 py-1 text-[12px] leading-4 text-white focus:text-white"
                          onSelect={() => chooseBrowser(b.id)}
                        >
                          <BrowserIcon browser={b} size={ROW_ICON_SIZE} />
                          <span className="truncate">{b.name}</span>
                          {b.id === browser.id && <CheckIcon size={ROW_ICON_SIZE} className="ml-auto shrink-0" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {showRecentWeb && (
                  <RecentSearches
                    label="Recent web searches"
                    searches={recentWeb}
                    display={(s) => s.slice(1)}
                    bordered
                    active={recentWebActive}
                    onActiveChange={setRecentWebActive}
                    onPick={runRecentWeb}
                  />
                )}
                {webShown && (
                  <div className="border-t border-white/[0.06]">
                    {webShown.kind === "loading" ? (
                      <div className="flex flex-col gap-2 p-3" role="status" aria-label={`Searching ${provider?.name}`}>
                        <div className="h-3 w-3/4 animate-pulse rounded-sm bg-white/10" />
                        <div className="h-3 w-1/2 animate-pulse rounded-sm bg-white/10" />
                      </div>
                    ) : webShown.kind === "error" ? (
                      <p role="alert" className="p-3 text-[12px] leading-4 text-zinc-400">
                        {webShown.message} <span className="text-zinc-500">
                          <Shortcut keys={["Ctrl", "Enter"]} /> searches in your browser.
                        </span>
                      </p>
                    ) : webResults.length ? (
                      <WebResults
                        results={webResults}
                        activeIndex={webActive}
                        onActiveIndexChange={setWebActive}
                        onOpen={openWebResult}
                        maxHeight={resultsMaxHeight() - WEB_ROW_HEIGHT}
                      />
                    ) : (
                      <p className="p-3 text-[12px] leading-4 text-zinc-400">No results.</p>
                    )}
                  </div>
                )}
              </>
            ) : showResults ? (
              <SearchResults
                results={visible}
                activeIndex={activeIndex}
                onActiveIndexChange={setActiveIndex}
                // A click is like Enter, Ctrl+click like Ctrl+Enter.
                onOpen={(r, ctrl) => openResult(r, ctrl !== enterReveals)}
                maxHeight={resultsMaxHeight()}
              />
            ) : showRecentFiles ? (
              <RecentSearches
                label="Recent searches"
                searches={recentFiles}
                active={recentFilesActive}
                onActiveChange={setRecentFilesActive}
                onPick={runRecentFile}
              />
            ) : (
              <IndexPanel state={index} onAllow={requestPermission} />
            )}
          </div>
        )}
        {/* The menu opens below the bar, outside the frame; the window only
            covers the frame, so make room for it while it's open. */}
        {browserMenuOpen && webQuery !== null && <div style={{ height: browsers.length * BROWSER_ITEM_HEIGHT }} />}
      </div>
    </div>
  );
}

/** Recent searches in a panel of their own: file searches under the empty
 *  box, web searches under the web-search row while only "/" is typed.
 *  Picking one runs it again. */
function RecentSearches({
  label,
  searches,
  display = (s) => s,
  bordered = false,
  active,
  onActiveChange,
  onPick,
}: {
  label: string;
  /** Newest first. */
  searches: string[];
  /** What a search reads as in the list (web searches drop their "/"). */
  display?: (search: string) => string;
  /** A hairline above, when it sits under another row. */
  bordered?: boolean;
  active: number | null;
  onActiveChange: (index: number | null) => void;
  onPick: (search: string) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={label}
      onMouseLeave={() => onActiveChange(null)}
      className={cn("flex flex-col p-1.5", bordered && "border-t border-white/[0.06]")}
    >
      {searches.map((s, i) => (
        <div
          key={s}
          role="option"
          aria-selected={i === active}
          onMouseMove={() => i !== active && onActiveChange(i)}
          onClick={() => onPick(s)}
          className={cn(
            "flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] leading-4 transition-colors duration-80",
            i === active ? "bg-white/10 text-white" : "text-zinc-400"
          )}
        >
          <ClockCounterClockwiseIcon size={ROW_ICON_SIZE} className="shrink-0" />
          <span className="truncate">{display(s)}</span>
        </div>
      ))}
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
