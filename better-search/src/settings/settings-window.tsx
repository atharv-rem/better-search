import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  ArrowClockwiseIcon,
  DownloadSimpleIcon,
  GearSixIcon,
  GlobeIcon,
  HouseIcon,
  HardDrivesIcon,
  InfoIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  TerminalIcon,
  WrenchIcon,
  type IconProps,
} from "@/lib/phosphor";
import { saveSettings, useSettings, type Settings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { usePendingUpdate } from "@/lib/update";
import { panelShadow } from "@/lib/surface-classes";
import { ActionButton, Group, Row } from "@/settings/controls";
import { ApiKeysSection } from "@/settings/api-keys-section";
import { GeneralSection } from "@/settings/general-section";
import { HomeSection } from "@/settings/home-section";
import { isHeldOpen } from "@/settings/keep-open";
import { IndexingSection } from "@/settings/indexing-section";
import { SearchSection, WebSection } from "@/settings/search-section";
import { ShortcutsSection } from "@/settings/shortcuts-section";
import { TroubleshootingSection } from "@/settings/troubleshooting-section";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;
type SectionProps = { settings: Settings; save: Save };

const SECTIONS: { id: string; name: string; icon: ComponentType<IconProps>; Content: ComponentType<SectionProps> }[] = [
  { id: "home", name: "Home", icon: HouseIcon, Content: () => null },
  { id: "general", name: "General", icon: GearSixIcon, Content: GeneralSection },
  { id: "indexing", name: "Indexing", icon: HardDrivesIcon, Content: IndexingSection },
  { id: "search", name: "Search", icon: MagnifyingGlassIcon, Content: SearchSection },
  { id: "web", name: "Web search", icon: GlobeIcon, Content: WebSection },
  { id: "shortcuts", name: "Shortcuts", icon: TerminalIcon, Content: ShortcutsSection },
  { id: "api-keys", name: "API keys", icon: KeyIcon, Content: ApiKeysSection },
  { id: "troubleshooting", name: "Troubleshoot", icon: WrenchIcon, Content: TroubleshootingSection },
  { id: "about", name: "About", icon: InfoIcon, Content: AboutSection },
];

const SECTION_KEY = "settings-section";

function loadSection() {
  try {
    const id = localStorage.getItem(SECTION_KEY);
    return SECTIONS.some((s) => s.id === id) ? id! : SECTIONS[0].id;
  } catch {
    return SECTIONS[0].id; // storage unavailable
  }
}

function closeWindow() {
  getCurrentWindow()
    .close()
    .catch(() => {});
}

export function SettingsWindow() {
  const settings = useSettings();
  const [sectionId, setSectionId] = useState(loadSection);
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0];
  const pendingUpdate = usePendingUpdate();
  const latest = useRef(settings);
  latest.current = settings;

  // Each change applies to the newest settings, not the ones a control last
  // rendered with. Resolves with a message to show if it wasn't saved.
  const save = useCallback<Save>(async (change) => {
    if (!latest.current) return null;
    try {
      latest.current = await saveSettings(change(latest.current));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  const choose = (id: string) => {
    setSectionId(id);
    try {
      localStorage.setItem(SECTION_KEY, id);
    } catch {
      // not remembered; still shows
    }
  };

  // Esc closes, unless a menu or the shortcut recorder took it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeWindow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A click outside the window closes it. Only once it has had focus, so it
  // can't close before it ever opened.
  useEffect(() => {
    const win = getCurrentWindow();
    let had = false;
    win
      .isFocused()
      .then((focused) => (had ||= focused))
      .catch(() => {});
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (focused) had = true;
      else if (had && !isHeldOpen()) closeWindow();
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return (
    // The padding is transparent window, room for the shadow (lib.rs sizes
    // the window to match).
    <div className="h-screen w-screen p-6">
    <div
      className="dark flex size-full overflow-hidden rounded-[14px] bg-black text-white select-none"
      style={{ boxShadow: panelShadow }}
    >
      <nav
        data-tauri-drag-region
        aria-label="Settings sections"
        className="flex w-32 shrink-0 flex-col gap-0.5 rounded-l-[14px] bg-[#070707] p-2"
      >
        {SECTIONS.map(({ id, name, icon: Icon }) => {
          const active = id === section.id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => choose(id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-7 items-center gap-2 rounded-md px-2 text-left text-[12px] leading-4 transition-colors",
                active ? "bg-white/[0.08] text-white" : "text-zinc-400 hover:bg-white/[0.04] hover:text-white"
              )}
            >
              {/* A fixed box, so glyphs of different widths (the filled house) sit on one line. */}
              <span className="flex size-4 shrink-0 items-center justify-center">
                <Icon size={14} weight={active ? "fill" : "regular"} />
              </span>
              <span className="truncate">{name}</span>
              {id === "about" && pendingUpdate && (
                <span className="ml-auto size-1.5 shrink-0 rounded-full bg-sky-400" aria-label="Update available" />
              )}
            </button>
          );
        })}
      </nav>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {section.id === "home" ? (
          <div key="home" className="absolute inset-0 motion-safe:animate-fade-in">
            <HomeSection />
          </div>
        ) : null}
        {/* Drag strip over the content's top padding, so it takes no room: the
            gap above a page matches the 20px at its sides. */}
        <header data-tauri-drag-region className="absolute inset-x-0 top-0 z-10 h-5" />
        {section.id !== "home" && (
          <div className="flex-1 overflow-y-auto p-5 select-text">
            {settings ? (
              <div key={section.id} className="mx-auto flex max-w-[560px] flex-col gap-4 motion-safe:animate-fade-in">
                <section.Content settings={settings} save={save} />
              </div>
            ) : (
              <div className="mx-auto h-40 max-w-[560px] animate-pulse rounded-xl bg-white/[0.04]" role="status" aria-label="Loading settings" />
            )}
          </div>
        )}
      </main>
    </div>
    </div>
  );
}

type UpdateState =
  | { kind: "idle" }
  | { kind: "unavailable" } // this build has no updater config
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; percent: number | null }
  | { kind: "installing" }
  | { kind: "error"; message: string };

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
    invoke<boolean>("can_update")
      .then((can) => !can && setUpdate({ kind: "unavailable" }))
      .catch(() => {});
  }, []);

  // The daily check found one: fetch it so the page offers it straight away.
  const pendingUpdate = usePendingUpdate();
  useEffect(() => {
    if (pendingUpdate && (update.kind === "idle" || update.kind === "latest")) checkForUpdate();
  }, [pendingUpdate]);

  const checkForUpdate = async () => {
    setUpdate({ kind: "checking" });
    try {
      const found = await check();
      setUpdate(found ? { kind: "available", update: found } : { kind: "latest" });
    } catch (err) {
      setUpdate({ kind: "error", message: `Couldn't check for updates: ${err}` });
    }
  };

  // Windows closes the app to run the installer, which opens it again after.
  const install = async (found: Update) => {
    let total = 0;
    let done = 0;
    setUpdate({ kind: "downloading", percent: null });
    try {
      await found.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          done += event.data.chunkLength;
          setUpdate({ kind: "downloading", percent: total ? Math.min(100, Math.round((done / total) * 100)) : null });
        } else setUpdate({ kind: "installing" });
      });
    } catch (err) {
      setUpdate({ kind: "error", message: `Couldn't install the update: ${err}` });
    }
  };

  const status = {
    idle: null,
    unavailable: "This build can't update itself.",
    checking: "Checking for updates…",
    latest: "You're on the latest version.",
    available: update.kind === "available" ? `Version ${update.update.version} is available.` : null,
    downloading:
      update.kind === "downloading"
        ? `Downloading the update${update.percent === null ? "…" : ` ${update.percent}%`}`
        : null,
    installing: "Installing. Better Search will restart.",
    error: null,
  }[update.kind];
  const busy = update.kind === "checking" || update.kind === "downloading" || update.kind === "installing";

  return (
    <Group>
      <Row
        label="Better Search"
        description={
          <>
            {version ? `Version ${version}` : "Version"}
            {status && <span className="block text-zinc-400">{status}</span>}
          </>
        }
        error={update.kind === "error" ? update.message : null}
      >
        {update.kind === "available" ? (
          <ActionButton variant="primary" onClick={() => install(update.update)}>
            <DownloadSimpleIcon size={14} />
            Update to {update.update.version}
          </ActionButton>
        ) : (
          update.kind !== "unavailable" && (
            <ActionButton disabled={busy} onClick={checkForUpdate}>
              <ArrowClockwiseIcon size={14} className={cn(update.kind === "checking" && "motion-safe:animate-spin")} />
              {update.kind === "checking" ? "Checking…" : "Check for updates"}
            </ActionButton>
          )
        )}
      </Row>
    </Group>
  );
}
