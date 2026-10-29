import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowSquareOutIcon, CaretDownIcon, CheckIcon, ClockCounterClockwiseIcon, GearSixIcon } from "@/lib/phosphor";
import { GlobalSearchIcon } from "@/components/global-search-icon";
import { RamIcon, TimeIcon } from "@/components/stat-icons";
import { BrowserIcon, DEFAULT_BROWSER, type BrowserOption } from "@/components/browser-icon";
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
import { SnapHeader, WindowList } from "@/components/snap-picker";
import { useSnap } from "@/hooks/use-snap";
import { countGroups, groupOf, type FileGroup } from "@/lib/file-groups";
import { appsMatching, installedApps, type InstalledApp } from "@/lib/snap";
import { cn } from "@/lib/utils";
import { usePendingUpdate } from "@/lib/update";
import { panelShadow, shortcutPill } from "@/lib/surface-classes";
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

/** The Start menu apps that match `query` above the files, the files'
 *  shortcuts to those same apps left out. The index only has apps that have
 *  a shortcut file; Store apps (Calculator, Settings) have none. */
function withApps(files: SearchResult[], apps: InstalledApp[], query: string, limit: number): SearchResult[] {
  const matched = appsMatching(apps, query);
  if (!matched.length) return files;
  const names = new Set(matched.map((a) => a.name.toLowerCase()));
  const isListedApp = (f: SearchResult) => /\.lnk$/i.test(f.name) && names.has(f.name.slice(0, -4).toLowerCase());
  const listed = matched.map(
    (app, i): SearchResult => ({
      id: -1 - i, // not in the index
      name: app.name,
      path: `shell:AppsFolder\\${app.id}`,
      type: "app",
      size: 0,
      modified_at: 0,
      open_count: 0,
      app_id: app.id,
    })
  );
  return [...listed, ...files.filter((f) => !isListedApp(f))].slice(0, limit);
}

/** "/ cats" searches the web for "cats"; null for an ordinary file search.
 *  `trigger` is the user's web search shortcut ("/" by default). */
function webQueryOf(query: string, trigger: string) {
  return query.startsWith(trigger) ? query.slice(trigger.length).trim() : null;
}

/** "\ tax notes" searches inside files for "tax notes"; null for anything
 *  else. `trigger` is the user's shortcut for it ("\" by default). */
function contentQueryOf(query: string, trigger: string) {
  return query.startsWith(trigger) ? query.slice(trigger.length).trim() : null;
}

/** What came of the newest content search, for the query it was for. */
type ContentState = { query: string; kind: "done" | "off" | "failed" };

/** "=3*2+4" and "3*2+4=" are calculations; null for anything else. */
function calcQueryOf(query: string) {
  if (query.startsWith("=")) return query.slice(1).trim();
  if (query.trimEnd().endsWith("=")) return query.trimEnd().slice(0, -1).trim();
  return null;
}

/** Top-level domains a bare "name.tld" opens as a website for. Only common
 *  ones that aren't also file extensions: "app.py" and "main.rs" are files. */
const URL_TLDS = new Set(
  "com org net io dev app ai co edu gov me in uk us ca de fr jp au xyz tech info so gg tv ly fm to cc site online store blog news page".split(" ")
);

/** The address to open for a typed URL ("github.com/x", "https://…",
 *  "localhost:3000"); null for anything else. */
function urlOf(query: string) {
  const q = query.trim();
  if (!q || /\s/.test(q)) return null;
  if (/^https?:\/\/[^/]/i.test(q)) return q;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(q)) return `http://${q}`;
  const host = /^((?:[a-z0-9-]+\.)+([a-z]{2,}))(:\d+)?([/?#]|$)/i.exec(q);
  if (!host) return null;
  if (!/^www\./i.test(host[1]) && !URL_TLDS.has(host[2].toLowerCase())) return null;
  return `https://${q}`;
}

/** Recent web searches are kept as "/cats" whatever the shortcut is, so
 *  changing it doesn't orphan them. */
const RECENT_WEB_PREFIX = "/";

/** Every icon in the web-search row and its browser menu, in pixels. */
const ROW_ICON_SIZE = 16;

/** Height of one menu item (16px line with py-1), for sizing the window. */
const BROWSER_ITEM_HEIGHT = 24;

/** The web-search row (p-3 around a 16px line), above a provider's results. */
const WEB_ROW_HEIGHT = 40;

function searchWeb(web: Settings["web"], text: string, browser: string) {
  return invoke("open_url", { url: webSearchUrl(web, text), browser }).then(() => hideWindow());
}

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
 *  the screen (`screenHeight`, see `useScreenHeight`) can't fit them, so the
 *  last one is never cut in half. */
function resultsMaxHeight(screenHeight: number) {
  const room = screenHeight - 2 * SCREEN_MARGIN - ABOVE_BAR - BAR_HEIGHT - BAR_TO_RESULTS;
  const rows = Math.min(RESULT_ROWS, Math.floor((room - RESULTS_PADDING) / RESULT_ROW));
  return Math.max(3, rows) * RESULT_ROW + RESULTS_PADDING;
}

/** Where the bar's top sits on screen: wherever centres everything at its
 *  fullest (pills, preview, bar, filters and a full results list) between
 *  the top of the screen and the taskbar. lib.rs `place_search` puts it
 *  there, so it stays put as results come and go. */
function barScreenTop(screenHeight: number) {
  const block = ABOVE_BAR + BAR_HEIGHT + BAR_TO_RESULTS + resultsMaxHeight(screenHeight);
  return Math.max(SCREEN_MARGIN, (screenHeight - block) / 2) + ABOVE_BAR;
}

/** The height of the screen the window is on, without the taskbar, in the
 *  page's CSS pixels. `screen.availHeight` would do but for the interface
 *  size: WebView2 doesn't scale it by the zoom, so it's read from the monitor
 *  and measured again with `measure` when the zoom or the monitor changes, or
 *  given in physical pixels with `setPhysical` when Rust already knows it. */
function useScreenHeight() {
  const [height, setHeight] = useState(screen.availHeight);
  const setPhysical = useCallback((physical: number) => setHeight(physical / window.devicePixelRatio), []);
  const measure = useCallback(() => {
    currentMonitor()
      .then((m) => m && setPhysical(m.workArea.size.height))
      .catch(() => {});
  }, [setPhysical]);
  useEffect(measure, [measure]);
  return [height, measure, setPhysical] as const;
}

/** What Rust sends with every show, and gives once when the page loads
 *  (lib.rs `ShownState`). */
interface ShownState {
  /** Newest first. */
  recent: string[];
  browsers: BrowserOption[];
  pending_update: string | null;
  /** The monitor's height without the taskbar, in physical pixels; null when
   *  the page should measure it. */
  work_height: number | null;
  /** Searching files (Alt+S), or snapping windows into a layout (Alt+W). */
  mode: "search" | "snap";
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
  // Null until the page has its first; refreshed on every show.
  const [shown, setShown] = useState<ShownState | null>(null);
  const pendingUpdate = usePendingUpdate(shown?.pending_update ?? null);
  // Snap mode has its own query (it filters the open windows), so the file
  // search's is still there when Alt+S switches back.
  const snapMode = shown?.mode === "snap";
  const snap = useSnap(snapMode, shownAt);
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [typeFilter, setTypeFilter] = useState<FileGroup | null>(null);
  // Set when the window comes back; the next new query drops the type filter.
  const reshown = useRef(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [index, setIndex] = useState<IndexState>({ kind: "checking" });
  const settings = useSettings() ?? DEFAULT_SETTINGS;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const queryRef = useRef(query);
  queryRef.current = query;
  // Newest first; as of the last show (the settings page may have cleared
  // them), plus what this page has added since.
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => setRecent(shown?.recent ?? []), [shown]);

  /** Keeps `text` as a recent search: called once something came of it. */
  const remember = useCallback((text: string) => {
    let t = text.trim();
    const web = webQueryOf(t, settingsRef.current.web.trigger);
    // "/cats" and "/ cats" are the same web search.
    if (web !== null) t = RECENT_WEB_PREFIX + web;
    // Would read back as a web search.
    else if (t.startsWith(RECENT_WEB_PREFIX)) return;
    if (!t || t === RECENT_WEB_PREFIX || !settingsRef.current.search.remember_recent) return;
    setRecent((r) => [t, ...r.filter((q) => q !== t)]);
    invoke("add_recent_search", { query: t }).catch(() => {});
  }, []);
  const { max_results: maxResults, enter_reveals: enterReveals, show_preview: showPreview } = settings.search;
  const browsers = useMemo(() => [DEFAULT_BROWSER, ...(shown?.browsers ?? [])], [shown]);
  // Local too, so Tab can cycle faster than the save comes back.
  const [savedBrowser, setSavedBrowser] = useState(settings.web.browser);
  useEffect(() => setSavedBrowser(settings.web.browser), [settings.web.browser]);
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false);
  // A browser that has since been uninstalled falls back to the default.
  const browser = browsers.find((b) => b.id === savedBrowser) ?? DEFAULT_BROWSER;
  const searchRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [screenHeight, measureScreen, setScreenHeight] = useScreenHeight();
  const screenHeightRef = useRef(screenHeight);
  screenHeightRef.current = screenHeight;
  const fitRef = useRef<(recenter?: boolean) => void>(() => {});
  const searchSeq = useRef(0);
  const indexRef = useRef(index);
  indexRef.current = index;

  const ready = index.kind === "ready";
  const trigger = settings.web.trigger;
  const webQuery = webQueryOf(query, trigger);
  const contentTrigger = settings.search.content_trigger;
  // Off hides image results; their text stays until deleted in settings.
  const imagesOn = settings.images.enabled;
  // Settings keep the two shortcuts from starting with each other.
  const contentQuery = webQuery === null ? contentQueryOf(query, contentTrigger) : null;
  // The web search shortcut wins if the user has set it to "=".
  const calcQuery = webQuery === null && contentQuery === null ? calcQueryOf(query) : null;
  // A typed URL opens the site instead of searching files or the web for it,
  // also after the web search shortcut ("/github.com").
  const urlQuery = webQuery !== null ? urlOf(webQuery) : calcQuery === null && contentQuery === null ? urlOf(query) : null;
  const [contentState, setContentState] = useState<ContentState | null>(null);
  const contentShown = contentQuery && contentState?.query === contentQuery ? contentState.kind : null;
  const rememberRecent = settings.search.remember_recent;
  const recentFiles = useMemo(() => recent.filter((q) => !q.startsWith(RECENT_WEB_PREFIX)).slice(0, RECENT_SHOWN), [recent]);
  const recentWeb = useMemo(() => recent.filter((q) => q.startsWith(RECENT_WEB_PREFIX)).slice(0, RECENT_SHOWN), [recent]);
  // Listed while only the trigger is typed; ArrowDown moves into the list.
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
  // The answer to the "=" calculation, shown after the text; for the
  // expression it was for, so typing on hides a stale one.
  const [calc, setCalc] = useState<{ expr: string; answer: string } | null>(null);
  const calcSeq = useRef(0);
  const calcAnswer = calc && calc.expr === calcQuery ? calc.answer : null;
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
    const fit = (recenter = false) => {
      // In physical pixels: Windows text scaling and the interface size
      // setting zoom the page, so CSS pixels aren't the window's logical ones.
      const { width, height, top } = frame.getBoundingClientRect();
      const barTop = (searchRef.current?.getBoundingClientRect().top ?? top) - top;
      const ratio = window.devicePixelRatio;
      invoke("resize_window", {
        width: Math.ceil(width * ratio),
        height: Math.ceil(height * ratio),
        // Rust keeps the bar in place, so the preview grows the window upwards.
        barTop: Math.round(barTop * ratio),
        barScreenTop: Math.round(barScreenTop(screenHeightRef.current) * ratio),
        recenter,
      }).catch(() => {});
    };
    fitRef.current = fit;
    const observer = new ResizeObserver(() => fit());
    observer.observe(frame);
    // A zoom leaves the page's CSS size as it was, so the observer misses it:
    // watch the pixel ratio too, re-armed for each new ratio. The screen's
    // height in CSS pixels changes with it, which recentres (below).
    let ratioQuery: MediaQueryList | null = null;
    const watchRatio = () => {
      ratioQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      ratioQuery.addEventListener("change", onRatio);
    };
    const onRatio = () => {
      ratioQuery?.removeEventListener("change", onRatio);
      watchRatio();
      fit();
      measureScreen();
    };
    watchRatio();
    return () => {
      observer.disconnect();
      ratioQuery?.removeEventListener("change", onRatio);
    };
  }, [measureScreen]);

  // The centred spot moves with the screen's height: put the bar there now.
  useEffect(() => fitRef.current(true), [screenHeight]);

  // The interface size setting, as the webview's zoom; the effect above refits.
  const uiScale = settings.ui_scale;
  useEffect(() => {
    getCurrentWebview().setZoom(uiScale).catch(() => {});
  }, [uiScale]);

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
    invoke<ShownState>("search_state")
      .then(setShown)
      .catch(() => {});

    const unlistenShown = listen<ShownState>("search-shown", ({ payload }) => {
      focusSearch();
      setShown(payload);
      // Opened on the monitor the mouse is on, which may be another one.
      if (payload.work_height) setScreenHeight(payload.work_height);
      else measureScreen();
      // A hidden window comes back with the last query: select it so typing
      // starts a new search, or clear it if the settings say so.
      if (settingsRef.current.search.clear_on_close) setQuery("");
      else searchRef.current?.querySelector("textarea")?.select();
      // The type filter goes with that search: typing a new one shows all.
      reshown.current = true;
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
  // The Start menu's apps, listed with the files. Read again on each show, as
  // apps get installed and removed.
  const apps = useRef<InstalledApp[]>([]);
  useEffect(() => {
    if (!shownAt) return;
    installedApps()
      .then((a) => (apps.current = a))
      .catch(() => {});
  }, [shownAt]);

  useEffect(() => {
    if (reshown.current) {
      reshown.current = false;
      setTypeFilter(null);
    }
  }, [query]);

  useEffect(() => {
    const seq = ++searchSeq.current;
    const web = webQueryOf(query, trigger) !== null;
    const inside = web ? null : contentQueryOf(query, contentTrigger);
    const other = inside === null && (web || calcQueryOf(query) !== null || urlOf(query) !== null);
    // Inside files doesn't need the app's own index: Windows Search answers it.
    if ((!ready && inside === null) || !query.trim() || other || inside === "") {
      setSearchMs(null);
      setResults([]);
      setActiveIndex(null);
      return;
    }
    const timer = setTimeout(() => {
      const started = performance.now();
      // Inside files: Windows Search's matches, without the Start menu's apps.
      const search =
        inside === null
          ? backend.search(query, maxResults).then((found) => withApps(found, apps.current, query, maxResults))
          : backend.searchContent(inside, maxResults, imagesOn);
      search
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setSearchMs(Math.max(1, Math.round(performance.now() - started)));
          setResults(r);
          setActiveIndex(r.length ? 0 : null);
          if (inside !== null) setContentState({ query: inside, kind: "done" });
        })
        .catch((err) => {
          if (seq !== searchSeq.current || inside === null) return;
          if (err instanceof BackendError && err.code === "superseded") return;
          setResults([]);
          setActiveIndex(null);
          const off = err instanceof BackendError && err.code === "no_windows_search";
          if (!off) console.error("Content search failed:", err);
          setContentState({ query: inside, kind: off ? "off" : "failed" });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, ready, shownAt, maxResults, trigger, contentTrigger, imagesOn]);

  // Calculate as you type, without the search's pause: the backend gives up
  // on anything that takes over 100 ms. Only the newest answer is shown.
  useEffect(() => {
    if (!calcQuery) return;
    const seq = ++calcSeq.current;
    invoke<string | null>("calculate", { expr: calcQuery })
      .then((answer) => {
        if (seq !== calcSeq.current) return;
        setCalc(answer === null ? null : { expr: calcQuery, answer });
      })
      .catch(() => {});
  }, [calcQuery]);

  /** Enter on a calculation: copies the answer and gets out of the way. */
  const copyAnswer = () => {
    if (calcAnswer === null) return;
    remember(query);
    navigator.clipboard
      .writeText(calcAnswer)
      .then(() => hideWindow())
      .catch((err) => console.error("Failed to copy:", err));
  };

  // Windows can take a while to come back from opening a file (a shortcut
  // that shows a dialog first), and the window is up until it does: one
  // open at a time, so more Enters don't open it again.
  const opening = useRef(false);
  const openResult = useCallback(async (r: SearchResult, reveal: boolean) => {
    if (opening.current) return;
    opening.current = true;
    remember(queryRef.current);
    try {
      if (r.type === "app") {
        // Not a file: nothing to reveal, and nothing in the index to rank.
        await invoke("open_app", { id: r.app_id });
      } else {
        // Recorded for ranking without waiting: hiding only trims the
        // backend, which still answers it.
        backend.markOpened(r.id).catch(() => {});
        await invoke("open_result", { path: r.path, reveal });
      }
    } catch (err) {
      console.error("Failed to open:", err);
      return;
    } finally {
      opening.current = false;
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
    const q = text.slice(RECENT_WEB_PREFIX.length);
    if (!q) return;
    const typed = trigger + q;
    setQuery(typed);
    remember(typed);
    const url = urlOf(q);
    if (url) openUrl(url);
    else if (provider) searchProvider(q);
    else searchWeb(settings.web, q, browser.id).catch((err) => console.error("Failed to open browser:", err));
  };

  /** Fills a recent file search into the box, which searches it. */
  const runRecentFile = (text: string) => {
    setQuery(text);
    searchRef.current?.querySelector("textarea")?.focus();
  };

  const openUrl = (url: string) =>
    invoke("open_url", { url, browser: browser.id })
      .then(() => hideWindow())
      .catch((err) => console.error("Failed to open browser:", err));
  const openWebResult = (r: WebResult) => openUrl(r.url);

  /** Enter on a typed URL: opens the site in the chosen browser. */
  const openTypedUrl = () => {
    if (urlQuery === null) return;
    remember(query);
    openUrl(urlQuery);
  };

  /** Tab in the web-search or URL row: the next browser; Shift+Tab goes back. */
  const cycleBrowser = (back: boolean) => {
    const at = browsers.findIndex((b) => b.id === browser.id);
    const step = back ? -1 : 1;
    chooseBrowser(browsers[(at + step + browsers.length) % browsers.length].id);
  };

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
    if (snapMode) {
      if (snap.handleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    // A held Enter repeats; only the first press opens, copies or searches.
    if (e.key === "Enter" && !e.shiftKey && e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
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
    if (calcQuery !== null) {
      // No results to move through; Enter copies the answer.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        copyAnswer();
      }
      return;
    }
    if (urlQuery !== null) {
      // Tab cycles the browser to open it in; Enter opens it.
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Tab") cycleBrowser(e.shiftKey);
        else openTypedUrl();
      }
      return;
    }
    if (webQuery !== null) {
      if (e.key === "Tab") {
        // Cycle the browser to search in; Shift+Tab goes back.
        e.preventDefault();
        e.stopPropagation();
        cycleBrowser(e.shiftKey);
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
      reshown.current = false;
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
    if (calcQuery !== null) {
      copyAnswer();
      return;
    }
    if (urlQuery !== null) {
      openTypedUrl();
      return;
    }
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

  const showResults = (ready || contentQuery !== null) && results.length > 0;
  // Inside files with nothing listed: a hint, or why there's nothing.
  const showContentNotice = contentQuery !== null && !showResults && (contentQuery === "" || contentShown !== null);
  const showPanel =
    webQuery !== null ||
    urlQuery !== null ||
    showResults ||
    showContentNotice ||
    showRecentFiles ||
    (index.kind !== "ready" && index.kind !== "checking");

  // Picks the browser at the end of the web-search and URL rows.
  const browserMenu = (
    <DropdownMenu onOpenChange={setBrowserMenuOpen}>
      <DropdownMenuTrigger
        className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-[12px] leading-4 text-white outline-hidden transition-colors hover:bg-white/10 focus-visible:bg-white/10 data-[state=open]:bg-white/10"
        aria-label="Browser to open in"
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
  );

  return (
    // The window is sized to this frame (see the resize effect), not the
    // screen; the padding is room for the shadow.
    <div ref={frameRef} className="dark relative w-fit p-6 select-none">
      <div className="w-110" onKeyDownCapture={handleKeyDownCapture}>
        {/* The row above the bar: the preview on the left, the stat pills on
            the right. Both sit on the row's bottom, so the pills stay just
            above the bar whether the preview is there or not. */}
        {snapMode ? (
          <SnapHeader snap={snap} />
        ) : (
        <div className="mb-2 flex items-end justify-between gap-2">
          {showResults && visible.length > 0 && showPreview && (
            // Its space is kept for as long as there are results (the square
            // fades out for ones with nothing to preview), so the window only
            // grows upwards once rather than as the preview comes and goes.
            <PreviewPanel
              result={visible[Math.min(activeIndex ?? 0, visible.length - 1)]}
              size={PREVIEW_SIZE}
              thumbSize={previewThumbSize()}
              // The pills' hairline, not the panel shadow: its drop would
              // shade the gap below and make it look narrower than theirs.
              style={{ boxShadow: statPillShadow }}
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
        )}
        <SearchBox
          ref={searchRef}
          maxRows={4}
          value={snapMode ? snap.query : query}
          onValueChange={snapMode ? snap.setQuery : setQuery}
          // "2+3=" already ends in "=": just the answer after it.
          ghost={snapMode || calcAnswer === null ? undefined : query.trimEnd().endsWith("=") ? calcAnswer : `= ${calcAnswer}`}
          placeholder={snapMode ? "find an open window or an app" : "what should i look for you?"}
          className="gap-0! bg-black! p-[5px]! text-white"
          style={{ boxShadow: panelShadow }}
          textareaClassName="placeholder:text-zinc-400!"
          leftSlot={
            snapMode ? (
              <span className="ml-1 flex h-4 items-center rounded-[5px] bg-sky-950 px-1 text-[9px] leading-3 text-sky-200/80 ring-1 ring-sky-500/20">
                Snap windows
              </span>
            ) : (
              contentQuery !== null ? (
                <span className="ml-1 flex h-4 items-center rounded-[5px] bg-emerald-950 px-1 text-[9px] leading-3 text-emerald-200/80 ring-1 ring-emerald-500/20">
                  Inside files
                </span>
              ) : (
                // One pill per shortcut, each in its search's colour: red for
                // the web, green for inside files.
                <span className="ml-1 flex items-center gap-2">
                  <span className="flex h-4 items-center gap-0.5 rounded-[5px] bg-[#2a0b0b] px-1 text-[9px] leading-3 text-red-200/80 ring-1 ring-red-500/20">
                    <span className="font-semibold text-red-300">{trigger}</span>
                    to search the web
                  </span>
                  <span className="flex h-4 items-center gap-0.5 rounded-[5px] bg-emerald-950 px-1 text-[9px] leading-3 text-emerald-200/80 ring-1 ring-emerald-500/20">
                    <span className="font-semibold text-emerald-300">{contentTrigger}</span>
                    inside files
                  </span>
                </span>
              )
            )
          }
          rightSlot={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={pendingUpdate ? `Settings (update ${pendingUpdate} available)` : "Settings"}
              title={pendingUpdate ? `Update ${pendingUpdate} available` : undefined}
              className="relative"
              onClick={() => invoke("open_settings").catch((err) => console.error("Failed to open settings:", err))}
            >
              <GearSixIcon size={16} />
              {pendingUpdate && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-sky-400" />}
            </Button>
          }
        />

        {snapMode && (
          <div className="mt-2 origin-top overflow-hidden rounded-xl bg-black text-white" style={{ boxShadow: panelShadow }}>
            <WindowList snap={snap} maxHeight={resultsMaxHeight(screenHeight)} />
          </div>
        )}

        {!snapMode && showResults && groups.length > 1 && (
          <TypeFilter
            groups={groups}
            total={results.length}
            selected={activeFilter}
            onSelect={(g) => {
              setTypeFilter(g);
              reshown.current = false;
              setActiveIndex(0);
            }}
          />
        )}

        {!snapMode && showPanel && (
          // Below the bar; the window grows downwards, so the bar never moves.
          <div
            // Rises in when it first appears (results, the web search row or
            // the indexing panel); transform only, so the window resizes once.
            className="mt-2 origin-top overflow-hidden rounded-xl bg-black text-white motion-safe:animate-rise-in"
            style={{ boxShadow: panelShadow }}
          >
            {urlQuery !== null ? (
              <div className="flex items-center gap-2 pr-2">
                <button
                  type="button"
                  onClick={openTypedUrl}
                  className="flex min-w-0 flex-1 items-center gap-2 p-3 pr-0 text-left text-[12px] leading-4"
                >
                  <ArrowSquareOutIcon size={ROW_ICON_SIZE} className="shrink-0" />
                  <span className="truncate">Open {webQuery ?? query.trim()}</span>
                </button>
                {browserMenu}
              </div>
            ) : webQuery !== null ? (
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
                    {webQuery && provider ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0">Search</span>
                        <span className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-white">
                          <img src={provider.logo} alt="" className="size-3 object-contain" draggable={false} />
                        </span>
                        <span className="truncate">
                          {provider.name} for {webQuery}
                        </span>
                      </span>
                    ) : (
                      <>
                        <GlobalSearchIcon size={ROW_ICON_SIZE} className="shrink-0" />
                        <span className="truncate">
                          {webQuery ? `Search the web for “${webQuery}”` : "Type something to search the web"}
                        </span>
                      </>
                    )}
                  </button>
                  {browserMenu}
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
                          <span className={shortcutPill}>Ctrl + Enter</span> searches in your browser.
                        </span>
                      </p>
                    ) : webResults.length ? (
                      <WebResults
                        results={webResults}
                        activeIndex={webActive}
                        onActiveIndexChange={setWebActive}
                        onOpen={openWebResult}
                        maxHeight={resultsMaxHeight(screenHeight) - WEB_ROW_HEIGHT}
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
                maxHeight={resultsMaxHeight(screenHeight)}
              />
            ) : showContentNotice ? (
              <ContentNotice query={contentQuery ?? ""} state={contentShown} />
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
        {browserMenuOpen && (webQuery !== null || urlQuery !== null) && <div style={{ height: browsers.length * BROWSER_ITEM_HEIGHT }} />}
      </div>
    </div>
  );
}

/** Under a content search with no results: what to type, or why nothing
 *  came back. */
function ContentNotice({ query, state }: { query: string; state: ContentState["kind"] | null }) {
  const openIndexing = () => invoke("open_indexing_options").catch((err) => console.error("Failed to open indexing options:", err));
  return (
    <p role="status" className="p-3 text-[12px] leading-4 text-zinc-400">
      {query === "" ? (
        "Type words to find the files that contain them."
      ) : state === "off" ? (
        "Windows Search is turned off, so file contents can't be searched. Turn on the Windows Search service to use it."
      ) : state === "failed" ? (
        "Windows Search couldn't answer that search."
      ) : (
        <>
          No files Windows has indexed contain “{query}”.{" "}
          <button
            type="button"
            onClick={openIndexing}
            className="text-zinc-300 underline decoration-white/30 underline-offset-2 hover:text-white"
          >
            Choose indexed folders
          </button>
        </>
      )}
    </p>
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
