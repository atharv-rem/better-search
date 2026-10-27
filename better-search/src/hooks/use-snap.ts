import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  filterApps,
  filterWindows,
  installedApps,
  LAYOUTS,
  openWindows,
  snapWindows,
  type InstalledApp,
  type OpenWindow,
  type SnapPick,
} from "@/lib/snap";

/** Picking a layout (ArrowLeft/Right, Enter), then filling its zones. */
export type SnapPhase = "layout" | "zones";

const wrap = (i: number, length: number) => (i + length) % length;

/** The snap mode's state and keys (Alt+W). `open` is whether the window is in
 *  snap mode; `shownAt` bumps on every show, which starts over with the
 *  windows open now. The layout chosen last time stays highlighted. */
export function useSnap(open: boolean, shownAt: number) {
  const [windows, setWindows] = useState<OpenWindow[]>([]);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [query, setQuery] = useState("");
  const [layoutIndex, setLayoutIndex] = useState(0);
  const [phase, setPhase] = useState<SnapPhase>("layout");
  const [zone, setZone] = useState(0);
  /** What goes in each zone of the chosen layout, null while empty. */
  const [assigned, setAssigned] = useState<(SnapPick | null)[]>([]);
  const [active, setActive] = useState<number | null>(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPhase("layout");
    setZone(0);
    setAssigned([]);
    setActive(0);
    openWindows()
      .then(setWindows)
      .catch(() => setWindows([]));
    // Read again on every show: apps come and go.
    installedApps()
      .then(setApps)
      .catch(() => setApps([]));
  }, [open, shownAt]);

  const layout = LAYOUTS[layoutIndex];
  // The open windows, then (once something is typed) the apps.
  const visible = useMemo<SnapPick[]>(
    () => [
      ...filterWindows(windows, query).map((window) => ({ kind: "window" as const, window })),
      ...filterApps(apps, query).map((app) => ({ kind: "app" as const, app })),
    ],
    [windows, apps, query]
  );
  // Typing narrows the list: start again from its top.
  useEffect(() => setActive(0), [query]);

  const chooseLayout = (index: number) => {
    setLayoutIndex(index);
    setPhase("zones");
    setZone(0);
    setAssigned(LAYOUTS[index].zones.map(() => null));
  };

  /** Puts a window or app in the current zone, then moves on to the next
   *  empty zone, or snaps them all once none is left. A window leaves any
   *  other zone it was in; an app can go in several, a window each. */
  const assign = (pick: SnapPick) => {
    const next = assigned.map((a) =>
      pick.kind === "window" && a?.kind === "window" && a.window.id === pick.window.id ? null : a
    );
    next[zone] = pick;
    setAssigned(next);
    setQuery("");
    const empty = next.map((_, i) => wrap(zone + 1 + i, next.length)).find((i) => next[i] === null);
    if (empty === undefined) apply(next);
    else setZone(empty);
  };

  const apply = (picks: (SnapPick | null)[]) => {
    snapWindows(layout, picks).catch((err) => console.error("Failed to snap windows:", err));
  };

  /** True when the key was the snap mode's. */
  const handleKey = (e: ReactKeyboardEvent) => {
    if (e.altKey || e.metaKey) return false;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const step = e.key === "ArrowRight" ? 1 : -1;
        if (phase === "layout") setLayoutIndex((i) => wrap(i + step, LAYOUTS.length));
        else setZone((z) => wrap(z + step, layout.zones.length));
        return true;
      }
      case "ArrowDown":
      case "ArrowUp": {
        if (!visible.length) return true;
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i === null ? 0 : wrap(i + step, visible.length)));
        return true;
      }
      case "Enter": {
        if (e.repeat) return true;
        if (phase === "layout") chooseLayout(layoutIndex);
        // Ctrl+Enter snaps what's placed so far, leaving the other zones empty.
        else if (e.ctrlKey) apply(assigned);
        else if (visible.length) assign(visible[Math.min(active ?? 0, visible.length - 1)]);
        return true;
      }
      case "Escape":
        // Back to the layouts; from there, Escape closes the window as usual.
        if (phase === "layout") return false;
        setPhase("layout");
        return true;
    }
    return false;
  };

  return {
    windows,
    visible,
    query,
    setQuery,
    layoutIndex,
    layout,
    phase,
    zone,
    setZone,
    assigned,
    active,
    setActive,
    chooseLayout,
    assign,
    handleKey,
  };
}

export type Snap = ReturnType<typeof useSnap>;
