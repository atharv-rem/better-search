import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiProviderId } from "@/lib/ai";
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
    /** What a search starts with to search inside files, like "\". */
    content_trigger: string;
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
  /** Answers from an AI model (ai.rs). */
  ai: {
    provider: AiProviderId | "off";
    /** The model picked for each provider; one without uses its default. */
    models: Partial<Record<AiProviderId, string>>;
    /** What a search starts with to ask the AI, like "?". */
    trigger: string;
    /** Search the web first, with the web search's provider, and answer
     *  from the results. */
    web_sources: boolean;
  };
  /** Applied the next time the index is rebuilt. */
  indexing: {
    excluded_drives: string[];
    /** Full paths, or folder names skipped wherever they are. */
    excluded_folders: string[];
  };
  /** Reading the text in images with Windows' OCR, for content search. */
  images: {
    enabled: boolean;
    /** Empty for the user's Desktop, Documents, Pictures and Downloads. */
    folders: string[];
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
export const DEFAULT_CONTENT_TRIGGER = "\\";
export const DEFAULT_AI_TRIGGER = "?";

/** Until the saved ones arrive. Matches `Settings::default` in settings.rs. */
export const DEFAULT_SETTINGS: Settings = {
  shortcut: "Alt+S",
  search: {
    max_results: 50,
    enter_reveals: false,
    clear_on_close: false,
    show_preview: true,
    remember_recent: true,
    content_trigger: DEFAULT_CONTENT_TRIGGER,
  },
  web: { engine: "google", custom_url: "", browser: "default", provider: "browser", trigger: DEFAULT_WEB_TRIGGER },
  ai: { provider: "off", models: {}, trigger: DEFAULT_AI_TRIGGER, web_sources: true },
  indexing: { excluded_drives: [], excluded_folders: [] },
  images: { enabled: false, folders: [] },
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
  // Assistants: the search is asked as a question.
  { id: "google-ai", name: "Google AI Mode", url: "https://www.google.com/search?udm=50&q=%s", ask: true },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/?q=%s", ask: true },
  { id: "claude", name: "Claude", url: "https://claude.ai/new?q=%s", ask: true },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/search?q=%s", ask: true },
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** The page a web search for `text` opens. */
export function webSearchUrl(web: Settings["web"], text: string) {
  const template =
    web.engine === "custom" ? web.custom_url : (SEARCH_ENGINES.find((e) => e.id === web.engine) ?? SEARCH_ENGINES[0]).url;
  return template.split("%s").join(encodeURIComponent(text));
}

/** The web search row's text: an assistant is asked, anything else searches the web. */
export function webSearchLabel(web: Settings["web"], text: string) {
  const engine = web.engine === "custom" ? undefined : SEARCH_ENGINES.find((e) => e.id === web.engine);
  if (engine && "ask" in engine) return text ? `Ask ${engine.name} “${text}”` : `Type something to ask ${engine.name}`;
  return text ? `Search the web for “${text}”` : "Type something to search the web";
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
