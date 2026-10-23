import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  FileTextIcon,
  GearSixIcon,
  GlobeIcon,
  HardDrivesIcon,
  InfoIcon,
  MagnifyingGlassIcon,
  XIcon,
  type IconProps,
} from "@phosphor-icons/react";
import { saveSettings, useSettings, type Settings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ActionButton, Group, Row } from "@/settings/controls";
import { GeneralSection } from "@/settings/general-section";
import { IndexingSection } from "@/settings/indexing-section";
import { SearchSection, WebSection } from "@/settings/search-section";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;
type SectionProps = { settings: Settings; save: Save };

const SECTIONS: { id: string; name: string; icon: ComponentType<IconProps>; Content: ComponentType<SectionProps> }[] = [
  { id: "general", name: "General", icon: GearSixIcon, Content: GeneralSection },
  { id: "indexing", name: "Indexing", icon: HardDrivesIcon, Content: IndexingSection },
  { id: "search", name: "Search", icon: MagnifyingGlassIcon, Content: SearchSection },
  { id: "web", name: "Web search", icon: GlobeIcon, Content: WebSection },
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

  return (
    <div className="dark flex h-screen w-screen overflow-hidden rounded-[14px] bg-black text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] select-none">
      <nav
        data-tauri-drag-region
        aria-label="Settings sections"
        className="flex w-[186px] shrink-0 flex-col gap-0.5 rounded-l-[14px] bg-[#141414] px-2 pt-3 pb-2 shadow-[inset_1px_1px_0_rgb(255_255_255/0.1),inset_0_-1px_0_rgb(255_255_255/0.1)]"
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
                "flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] leading-4 transition-colors",
                active ? "bg-white/[0.08] text-white" : "text-zinc-400 hover:bg-white/[0.04] hover:text-white"
              )}
            >
              <Icon size={16} weight={active ? "fill" : "regular"} className="shrink-0" />
              <span className="truncate">{name}</span>
            </button>
          );
        })}
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className="flex h-14 shrink-0 items-center justify-between pr-3 pl-8">
          <h1 data-tauri-drag-region className="text-[15px] leading-5 font-semibold">
            {section.name}
          </h1>
          <button
            type="button"
            onClick={closeWindow}
            aria-label="Close settings"
            className="flex size-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          >
            <XIcon size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-8 pb-8 select-text">
          {settings ? (
            <div key={section.id} className="flex max-w-[600px] flex-col gap-6 motion-safe:animate-fade-in">
              <section.Content settings={settings} save={save} />
            </div>
          ) : (
            <div className="h-40 animate-pulse rounded-xl bg-white/[0.04]" role="status" aria-label="Loading settings" />
          )}
        </div>
      </main>
    </div>
  );
}

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <Group>
      <Row label="Better Search" description={version ? `Version ${version}` : undefined} />
      <Row label="Logs" description="What the app and the indexer wrote while running, for tracking down problems." error={error}>
        <ActionButton
          onClick={() =>
            invoke("open_logs_folder")
              .then(() => setError(null))
              .catch((err) => setError(String(err)))
          }
        >
          <FileTextIcon size={14} />
          Open logs folder
        </ActionButton>
      </Row>
    </Group>
  );
}
