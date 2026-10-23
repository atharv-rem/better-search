import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GlobalSearchIcon } from "@/components/global-search-icon";
import { loadIcon } from "@/components/file-icon";

/** A browser a web search can go to. The installed ones come from `list_browsers`
 *  in lib.rs; "default" (the system's default browser) is always first. */
export type BrowserOption = { id: string; name: string; exe?: string };
export const DEFAULT_BROWSER: BrowserOption = { id: "default", name: "Default browser" };

/** The browser's own icon from Windows; a globe for the default option, and
 *  until (or unless) the icon loads. */
export function BrowserIcon({ browser, size }: { browser: BrowserOption; size: number }) {
  const [loaded, setLoaded] = useState<{ exe: string; url: string | null } | null>(null);
  const { exe } = browser;
  useEffect(() => {
    if (!exe) return;
    let cancelled = false;
    loadIcon(exe).then((url) => {
      if (!cancelled) setLoaded({ exe, url });
    });
    return () => {
      cancelled = true;
    };
  }, [exe]);

  const url = exe && loaded?.exe === exe ? loaded.url : null;
  if (url) {
    return <img src={url} alt="" width={size} height={size} draggable={false} className="shrink-0 object-contain" />;
  }
  return <GlobalSearchIcon size={size} className="shrink-0" />;
}

/** The default browser and the installed ones, read again whenever `refresh`
 *  changes: a browser may have been installed meanwhile. */
export function useInstalledBrowsers(refresh: unknown) {
  const [installed, setInstalled] = useState<BrowserOption[]>([]);
  useEffect(() => {
    invoke<BrowserOption[]>("list_browsers")
      .then(setInstalled)
      .catch(() => {});
  }, [refresh]);
  return useMemo(() => [DEFAULT_BROWSER, ...installed], [installed]);
}
