import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AppWindowIcon } from "@/lib/phosphor";
import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { panelShadow, shortcutPill } from "@/lib/surface-classes";
import { FileIcon, loadIcon } from "@/components/file-icon";
import { parentOf } from "@/components/search-results";
import { imageCache } from "@/lib/image-cache";
import { LAYOUTS, pickKey, programName, type InstalledApp, type OpenWindow, type SnapPick, type Zone } from "@/lib/snap";
import type { Snap } from "@/hooks/use-snap";

const panel = "overflow-hidden rounded-xl bg-black text-white";

/** Zones are drawn as squircles. The corner bends in later than a round one,
 *  so it takes about twice the radius to look as rounded. */
const squircle = "[corner-shape:squircle]";

/** A zone's place inside a drawing of the screen. */
const zoneStyle = (z: Zone): CSSProperties => ({
  left: `${z.x * 100}%`,
  top: `${z.y * 100}%`,
  width: `${z.width * 100}%`,
  height: `${z.height * 100}%`,
});

function Keys({ hints }: { hints: [string, string][] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-3 text-zinc-500">
      {hints.map(([key, what]) => (
        <span key={key} className="whitespace-nowrap">
          <span className={cn(shortcutPill, "mx-0 mr-1 h-4 px-1 text-[10px]")}>{key}</span>
          {what}
        </span>
      ))}
    </span>
  );
}

/** Above the bar: the snap mode's header. Every layout while one is being
 *  picked, then the chosen one, large, with the windows placed in it. */
export function SnapHeader({ snap }: { snap: Snap }) {
  return (
    <div className={cn(panel, "mb-2 p-1.5")} style={{ boxShadow: panelShadow }}>
      {snap.phase === "layout" ? <LayoutStrip snap={snap} /> : <ZonePreview snap={snap} />}
    </div>
  );
}

function LayoutStrip({ snap }: { snap: Snap }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div role="listbox" aria-label="Layouts" className="flex gap-2">
        {LAYOUTS.map((layout, i) => {
          const selected = i === snap.layoutIndex;
          return (
            <button
              key={layout.name}
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={layout.name}
              title={layout.name}
              onClick={() => snap.chooseLayout(i)}
              className={cn(
                "aspect-[16/10] flex-1 rounded-lg p-1 transition-colors duration-80",
                selected ? "bg-white/10 ring-1 ring-white/40" : "hover:bg-white/5"
              )}
            >
              <span className="relative block size-full">
                {layout.zones.map((z, j) => (
                  // 2px each side: 4px between neighbouring zones.
                  <span key={j} className="absolute p-0.5" style={zoneStyle(z)}>
                    <span
                      className={cn("block size-full rounded-[8px]", squircle, selected ? "bg-zinc-200" : "bg-zinc-600")}
                    />
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="truncate text-[12px] leading-4" style={{ fontVariationSettings: fontWeights.semibold }}>
          {snap.layout.name}
        </span>
        <Keys hints={[["← →", "layout"], ["Enter", "choose"]]} />
      </div>
    </div>
  );
}

/** What a zone shows for what's in it: the program's name, the app's, or the file's. */
function pickLabel(pick: SnapPick) {
  if (pick.kind === "window") return programName(pick.window.exe) || pick.window.title;
  return pick.kind === "app" ? pick.app.name : pick.file.name;
}

function ZonePreview({ snap }: { snap: Snap }) {
  return (
    <div className="flex gap-3">
      <div className="relative aspect-[16/10] h-24 shrink-0">
        {snap.layout.zones.map((z, i) => {
          const pick = snap.assigned[i];
          const current = i === snap.zone;
          return (
            <div key={i} className="absolute p-0.5" style={zoneStyle(z)}>
              <button
                type="button"
                aria-label={pick ? `Zone ${i + 1}: ${pickLabel(pick)}` : `Zone ${i + 1}`}
                aria-current={current}
                onClick={() => snap.setZone(i)}
                className={cn(
                  "flex size-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-[10px] px-1 transition-colors duration-80",
                  squircle,
                  current ? "bg-white/15 ring-1 ring-white/70" : pick ? "bg-white/10" : "bg-white/[0.04] ring-1 ring-white/10 ring-inset"
                )}
              >
                {pick ? (
                  <>
                    <PickIcon pick={pick} size={16} />
                    <span className="max-w-full truncate text-[9px] leading-3 text-zinc-300">{pickLabel(pick)}</span>
                  </>
                ) : (
                  <span className="text-[10px] leading-3 text-zinc-500 tabular-nums">{i + 1}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
        <div className="flex flex-col gap-0.5">
          <span className="truncate text-[12px] leading-4" style={{ fontVariationSettings: fontWeights.semibold }}>
            {snap.layout.name}
          </span>
          <span className="text-[11px] leading-4 text-zinc-400">
            Pick a window, app or file for zone {snap.zone + 1} of {snap.layout.zones.length}
          </span>
        </div>
        <Keys
          hints={[
            ["← →", "zone"],
            ["↑ ↓", "pick"],
            ["Enter", "place"],
            ["Ctrl + Enter", "snap now"],
            ["Esc", "layouts"],
          ]}
        />
      </div>
    </div>
  );
}

/** Below the bar: the open windows, narrowed by what's typed, then the
 *  installed apps and the indexed files that match it. */
export function WindowList({ snap, maxHeight }: { snap: Snap; maxHeight: number }) {
  const listRef = useRef<HTMLDivElement>(null);
  const { active } = snap;
  useEffect(() => {
    if (active === null) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!snap.visible.length) {
    return (
      <p className="p-3 text-[12px] leading-4 text-zinc-400">
        {snap.query.trim() ? "No open windows, apps or files match." : "No open windows to snap. Type to find an app or file."}
      </p>
    );
  }
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Open windows, apps and files"
      className="flex flex-col overflow-y-auto p-1.5"
      style={{ maxHeight }}
    >
      {snap.visible.map((pick, i) => {
        const key = pickKey(pick);
        const zones = snap.phase === "zones" ? snap.assigned.flatMap((a, z) => (a && pickKey(a) === key ? [z + 1] : [])) : [];
        const selected = i === active;
        const title = pick.kind === "window" ? pick.window.title : pickLabel(pick);
        const detail =
          pick.kind === "window"
            ? programName(pick.window.exe)
            : pick.kind === "app"
              ? "App · opens in its zone"
              : `${parentOf(pick.file.path)} · opens in its zone`;
        return (
          <div
            key={key}
            data-index={i}
            role="option"
            aria-selected={selected}
            title={pick.kind === "window" ? pick.window.exe || undefined : pick.kind === "file" ? pick.file.path : undefined}
            onMouseMove={() => !selected && snap.setActive(i)}
            onClick={() => (snap.phase === "zones" ? snap.assign(pick) : snap.setActive(i))}
            className={cn(
              "flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors duration-80",
              selected && "bg-white/10"
            )}
          >
            <PickIcon pick={pick} size={18} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span
                className={cn("truncate text-[12px] leading-4", selected ? "text-white" : "text-zinc-200")}
                style={{ fontVariationSettings: fontWeights.semibold }}
              >
                {title}
              </span>
              {detail && <span className="truncate text-[10px] leading-3 text-zinc-500">{detail}</span>}
            </div>
            {zones.length > 0 && (
              <span className="shrink-0 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] leading-3 text-zinc-200">
                Zone {zones.join(", ")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PickIcon({ pick, size }: { pick: SnapPick; size: number }) {
  if (pick.kind === "window") return <WindowIcon window={pick.window} size={size} />;
  return pick.kind === "app" ? <AppIcon app={pick.app} size={size} /> : <FileIcon result={pick.file} size={size} />;
}

// Installed apps' icons by app id (null: none).
const appIcons = imageCache("installed_app_icon", 200);

/** The app's icon from the Start menu, or a generic window glyph. */
function AppIcon({ app, size }: { app: InstalledApp; size: number }) {
  const [loaded, setLoaded] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    appIcons(app.id, { id: app.id }).then((url) => {
      if (!cancelled) setLoaded({ id: app.id, url });
    });
    return () => {
      cancelled = true;
    };
  }, [app.id]);

  const url = loaded?.id === app.id ? loaded.url : null;
  if (url) {
    return <img src={url} alt="" width={size} height={size} draggable={false} className="shrink-0 object-contain" />;
  }
  return <AppWindowIcon size={size} weight="duotone" color="#4C9BF0" className="shrink-0" />;
}

/** The window's program icon, or a generic window glyph. */
function WindowIcon({ window: w, size }: { window: OpenWindow; size: number }) {
  const [loaded, setLoaded] = useState<{ exe: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!w.exe) return;
    let cancelled = false;
    loadIcon(w.exe).then((url) => {
      if (!cancelled) setLoaded({ exe: w.exe, url });
    });
    return () => {
      cancelled = true;
    };
  }, [w.exe]);

  const url = loaded?.exe === w.exe ? loaded.url : null;
  if (url) {
    return <img src={url} alt="" width={size} height={size} draggable={false} className="shrink-0 object-contain" />;
  }
  return <AppWindowIcon size={size} weight="duotone" color="#4C9BF0" className="shrink-0" />;
}
