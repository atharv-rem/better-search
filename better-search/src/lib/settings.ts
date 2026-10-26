import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProviderId } from "@/lib/web-search";

// The user's settings. The shell owns them (settings.rs, which also checks
// every change); each window reads them with `useSettings` and stays in sync
// through the "settings-changed" event that every save sends.

export interface Settings {
  /** Opens and closes the search, like "Alt+S". */
  shortcut: string;
  search: {
    max_results: number;
    /** Enter shows the result in Explorer and Ctrl+Enter opens it. */
    enter_reveals: boolean;
    clear_on_close: boolean;
    show_preview: boolean;
    /** List the last searches under the empty search box. */
    remember_recent: boolean;
  };
  web: {
    engine: SearchEngineId | "custom";
    /** An https URL with %s where the query goes, for the "custom" engine. */
    custom_url: string;
    /** A browser id from `list_browsers`, or "default". */
    browser: string;
    /** "browser" opens web searches in the browser; a provider shows its
     *  results in the search window, with the user's key for it. */
    provider: ProviderId | "browser";
    /** What a search starts with to search the web, like "/". */
    trigger: string;
  };
  /** Applied the next time the index is rebuilt. */
  indexing: {
    excluded_drives: string[];
    /** Full paths, or folder names skipped wherever they are. */
    excluded_folders: string[];
  };
  /** The search window's zoom, on top of Windows' display scaling: 1 is
   *  100%. The shell keeps it within `UI_SCALE_MIN`..`UI_SCALE_MAX`. */
  ui_scale: number;
  /** The first-run screen has been finished or skipped. */
  onboarded: boolean;
  /** The index's folder when it was moved to another drive, empty for the
   *  default place. Only `moveIndex` (storage.ts) changes it. */
  index_folder: string;
}

export const DEFAULT_WEB_TRIGGER = "/";

/** Until the saved ones arrive. Matches `Settings::default` in settings.rs. */
export const DEFAULT_SETTINGS: Settings = {
  shortcut: "Alt+S",
  search: { max_results: 50, enter_reveals: false, clear_on_close: false, show_preview: true, remember_recent: true },
  web: { engine: "google", custom_url: "", browser: "default", provider: "browser", trigger: DEFAULT_WEB_TRIGGER },
  indexing: { excluded_drives: [], excluded_folders: [] },
  ui_scale: 1,
  // Only a fallback for a failed read; the first-run screen is the shell's call.
  onboarded: true,
  index_folder: "",
};

/** Matches `validate` in settings.rs. */
export const UI_SCALE_MIN = 0.7;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.1;

export const SEARCH_ENGINES = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=%s" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=%s" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  { id: "brave", name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** The page a web search for `text` opens. */
export function webSearchUrl(web: Settings["web"], text: string) {
  const template =
    web.engine === "custom" ? web.custom_url : (SEARCH_ENGINES.find((e) => e.id === web.engine) ?? SEARCH_ENGINES[0]).url;
  return template.split("%s").join(encodeURIComponent(text));
}

/** Saves the whole settings. Rejects with a message to show (a shortcut
 *  another app has, a bad search URL) and then nothing is saved. */
export function saveSettings(settings: Settings): Promise<Settings> {
  return invoke<Settings>("update_settings", { settings }).catch((err) => {
    throw new Error(String(err));
  });
}

/** The saved settings, kept current; null until they've loaded. */
export function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<Settings>("get_settings")
      .then((s) => !cancelled && setSettings(s))
      .catch(() => !cancelled && setSettings(DEFAULT_SETTINGS));
    const unlisten = listen<Settings>("settings-changed", ({ payload }) => setSettings(payload));
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);
  return settings;
}
