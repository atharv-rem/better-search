import { invoke } from "@tauri-apps/api/core";
import type { SearchResult } from "@/lib/backend";

/** A window as Alt+Tab lists it (snap.rs `OpenWindow`). */
export interface OpenWindow {
  /** The window's handle. */
  id: number;
  title: string;
  /** The program behind it, for its icon; "" when unreadable. */
  exe: string;
}

/** An app as the Start menu lists it (snap.rs `InstalledApp`). */
export interface InstalledApp {
  /** Its id in the Apps folder, which launches it. */
  id: string;
  name: string;
}

/** What goes in a zone: an open window, or an app launched or a file opened
 *  for it. */
export type SnapPick =
  | { kind: "window"; window: OpenWindow }
  | { kind: "app"; app: InstalledApp }
  | { kind: "file"; file: SearchResult };

export const pickKey = (p: SnapPick) =>
  p.kind === "window" ? `window:${p.window.id}` : p.kind === "app" ? `app:${p.app.id}` : `file:${p.file.path}`;

/** Part of the screen, as fractions of its work area (0 to 1). */
export interface Zone {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapLayout {
  name: string;
  /** In reading order, which ArrowLeft/Right walks. */
  zones: Zone[];
}

const zone = (x: number, y: number, width: number, height: number): Zone => ({ x, y, width, height });

/** Every layout the snap mode offers, in the order of the row above the bar:
 *  Windows' own Snap Layouts (Win+Z), in its order and proportions. */
export const LAYOUTS: SnapLayout[] = [
  { name: "Halves", zones: [zone(0, 0, 0.5, 1), zone(0.5, 0, 0.5, 1)] },
  { name: "Wide and narrow", zones: [zone(0, 0, 0.6, 1), zone(0.6, 0, 0.4, 1)] },
  {
    name: "Half and two quarters",
    zones: [zone(0, 0, 0.5, 1), zone(0.5, 0, 0.5, 0.5), zone(0.5, 0.5, 0.5, 0.5)],
  },
  {
    name: "Quarters",
    zones: [zone(0, 0, 0.5, 0.5), zone(0.5, 0, 0.5, 0.5), zone(0, 0.5, 0.5, 0.5), zone(0.5, 0.5, 0.5, 0.5)],
  },
];

/** "C:\…\Code.exe" -> "Code". */
export function programName(exe: string) {
  return exe.slice(exe.lastIndexOf("\\") + 1).replace(/\.exe$/i, "");
}

/** Windows whose title or program contains what's typed. */
export function filterWindows(windows: OpenWindow[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return windows;
  return windows.filter((w) => w.title.toLowerCase().includes(q) || programName(w.exe).toLowerCase().includes(q));
}

/** Apps listed under the windows once something is typed. */
const APPS_SHOWN = 20;

/** How an app's name matches `q` (lower-cased): 0 it starts with it, 1 a word
 *  in it does, 2 it's somewhere inside; -1 not at all. */
function appRank(name: string, q: string) {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.split(/[\s\-_.]+/).some((word) => word.startsWith(q))) return 1;
  return n.includes(q) ? 2 : -1;
}

/** Apps whose name contains what's typed: names that start with it first,
 *  then a word in them that does. None while nothing is typed. */
export function filterApps(apps: InstalledApp[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return apps
    .map((app) => ({ app, rank: appRank(app.name, q) }))
    .filter((a) => a.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, APPS_SHOWN)
    .map((a) => a.app);
}

/** Apps listed above the files in a search. */
const APPS_IN_SEARCH = 3;

/** The apps a file search lists first: only names that start with what's
 *  typed, or have a word that does ("code" finds Visual Studio Code), so an
 *  app doesn't push files down for a word that's merely inside its name. An
 *  exact name leads, then shorter names. */
export function appsMatching(apps: InstalledApp[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return apps
    .map((app) => ({ app, rank: appRank(app.name, q), exact: app.name.toLowerCase() === q }))
    .filter((a) => a.rank === 0 || a.rank === 1)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.rank - b.rank || a.app.name.length - b.app.name.length)
    .slice(0, APPS_IN_SEARCH)
    .map((a) => a.app);
}

export function openWindows() {
  return invoke<OpenWindow[]>("open_windows");
}

export function installedApps() {
  return invoke<InstalledApp[]>("installed_apps");
}

/** Moves each window into its zone, launching the apps and opening the files
 *  picked for zones first; zones left empty are skipped. Rust hides the
 *  search first. */
export function snapWindows(layout: SnapLayout, assigned: (SnapPick | null)[]) {
  const placements = layout.zones.flatMap((z, i) => {
    const pick = assigned[i];
    if (!pick) return [];
    const what =
      pick.kind === "window"
        ? { id: pick.window.id, app: null, file: null }
        : pick.kind === "app"
          ? { id: null, app: pick.app.id, file: null }
          : { id: null, app: null, file: pick.file.path };
    return [{ ...what, ...z }];
  });
  if (!placements.length) return Promise.resolve();
  return invoke("snap_windows", { placements });
}
