import { invoke } from "@tauri-apps/api/core";

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

/** What goes in a zone: an open window, or an app launched for it. */
export type SnapPick = { kind: "window"; window: OpenWindow } | { kind: "app"; app: InstalledApp };

export const pickKey = (p: SnapPick) => (p.kind === "window" ? `window:${p.window.id}` : `app:${p.app.id}`);

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
const THIRD = 1 / 3;

/** Every layout the snap mode offers, in the order of the row above the bar. */
export const LAYOUTS: SnapLayout[] = [
  { name: "Halves", zones: [zone(0, 0, 0.5, 1), zone(0.5, 0, 0.5, 1)] },
  {
    name: "Half and two quarters",
    zones: [zone(0, 0, 0.5, 1), zone(0.5, 0, 0.5, 0.5), zone(0.5, 0.5, 0.5, 0.5)],
  },
  { name: "Two-thirds and a third", zones: [zone(0, 0, 2 * THIRD, 1), zone(2 * THIRD, 0, THIRD, 1)] },
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

/** Apps whose name contains what's typed: names that start with it first,
 *  then a word in them that does. None while nothing is typed. */
export function filterApps(apps: InstalledApp[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/[\s\-_.]+/).some((word) => word.startsWith(q))) return 1;
    return n.includes(q) ? 2 : -1;
  };
  return apps
    .map((app) => ({ app, rank: rank(app.name) }))
    .filter((a) => a.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, APPS_SHOWN)
    .map((a) => a.app);
}

export function openWindows() {
  return invoke<OpenWindow[]>("open_windows");
}

export function installedApps() {
  return invoke<InstalledApp[]>("installed_apps");
}

/** Moves each window into its zone, launching the apps picked for zones
 *  first; zones left empty are skipped. Rust hides the search first. */
export function snapWindows(layout: SnapLayout, assigned: (SnapPick | null)[]) {
  const placements = layout.zones.flatMap((z, i) => {
    const pick = assigned[i];
    if (!pick) return [];
    return [pick.kind === "window" ? { id: pick.window.id, app: null, ...z } : { id: null, app: pick.app.id, ...z }];
  });
  if (!placements.length) return Promise.resolve();
  return invoke("snap_windows", { placements });
}
