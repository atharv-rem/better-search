import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { FileImageIcon, HardDriveIcon } from "@/lib/phosphor";
import { backend, BackendError, type IndexProgress } from "@/lib/backend";
import { saveSettings, type Settings } from "@/lib/settings";
import { diskSize, indexLocation, moveIndex, roomyDrives, type Drive, type IndexLocation } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { ArcBands } from "@/components/arc-bands";
import { MilestoneRail, type MilestoneStep } from "@/components/milestone-rail";
import { panelShadow } from "@/lib/surface-classes";

type Step =
  | { kind: "allow"; message?: string }
  // The index's drive is short of space: pick another, or free some up.
  | { kind: "space"; location: IndexLocation; drives: Drive[]; message?: string }
  | { kind: "asking" } // the Windows permission prompt is open
  | { kind: "indexing"; progress?: IndexProgress; overall: number }
  // Whether to read the text in images too (images.rs); count is for "done".
  | { kind: "images"; count: number }
  | { kind: "done"; count: number; images: boolean }
  | { kind: "error"; message: string };

const STEPS: MilestoneStep[] = [
  { id: "permission", title: "Permission", description: "Allow administrator access" },
  { id: "indexing", title: "Indexing", description: "Read your drives' file names" },
  { id: "images", title: "Images", description: "Search the text in pictures" },
  { id: "done", title: "Done", description: "Start searching" },
];

/** `VITE_ONBOARDING=<screen> npm run tauri dev` opens on that screen, with
 *  made-up numbers, without resetting the settings or deleting the index.
 *  Dev builds only. The buttons still do the real thing. */
const PREVIEW = import.meta.env.DEV ? previewStep(import.meta.env.VITE_ONBOARDING) : undefined;

function previewStep(screen: string | undefined): Step | undefined {
  const GB = 2 ** 30;
  switch (screen) {
    case "permission":
      return { kind: "allow" };
    case "denied":
      return { kind: "allow", message: "Windows permission was declined. Better Search can't search your drives without it." };
    case "space":
      return {
        kind: "space",
        location: {
          folder: "C:\\Users\\you\\AppData\\Local\\better-search",
          drive: "C:",
          default_drive: "C:",
          index_bytes: 0,
          needed_bytes: 300 * 2 ** 20,
          free_bytes: 0.1 * GB,
        },
        drives: [
          { letter: "C:", label: "Windows", ntfs: true, total_bytes: 256 * GB, free_bytes: 0.1 * GB },
          { letter: "D:", label: "Data", ntfs: true, total_bytes: 1024 * GB, free_bytes: 420 * GB },
          { letter: "E:", label: "Backup", ntfs: true, total_bytes: 2048 * GB, free_bytes: 1300 * GB },
        ],
      };
    case "indexing":
      return { kind: "indexing", progress: { drive: "C:", phase: "reading", done: 420_000, total: 1_000_000 }, overall: 0.21 };
    case "images":
      return { kind: "images", count: 216_016 };
    case "done":
      return { kind: "done", count: 216_016, images: true };
    case "error":
      return { kind: "error", message: "The index couldn't be saved." };
  }
  return undefined;
}

const stepOf = (step: Step) =>
  step.kind === "allow" || step.kind === "asking" || step.kind === "space" || step.kind === "error"
    ? 0
    : step.kind === "indexing"
      ? 1
      : step.kind === "images"
        ? 2
        : 3;

/** Marks the first run as over and closes the window. */
async function finish() {
  try {
    const settings = await invoke<Settings>("get_settings");
    await saveSettings({ ...settings, onboarded: true });
  } catch {
    // Not saved: it shows again next time, which is the safer way round.
  }
  getCurrentWindow()
    .close()
    .catch(() => {});
}

/** Set once the window has been grown for Windows' text size, so React's
 *  doubled effects in development don't grow it twice. */
let fitted = false;

/** Windows' text size setting zooms the page on top of the display scaling,
 *  so lib.rs's window, sized in display pixels, is too small for the layout
 *  (at 120%, 600 of the page's 720 pixels fit). Grow the window by the zoom
 *  and centre it again. */
async function fitToTextSize() {
  if (fitted) return;
  fitted = true;
  const win = getCurrentWindow();
  const [factor, size] = await Promise.all([win.scaleFactor(), win.innerSize()]);
  const zoom = window.devicePixelRatio / factor;
  if (Math.abs(zoom - 1) < 0.01) return;
  await win.setSize(new PhysicalSize(Math.round(size.width * zoom), Math.round(size.height * zoom)));
  await win.center();
}

export function OnboardingWindow() {
  const [step, setStep] = useState<Step>(PREVIEW ?? { kind: "allow" });

  useEffect(() => {
    fitToTextSize().catch(() => {});
  }, []);
  // Drives the index will read, in the order they're read, to turn each
  // drive's own progress into one bar for the whole thing.
  const drives = useRef<string[]>([]);
  const furthest = useRef(0);

  useEffect(() => {
    Promise.all([invoke<Drive[]>("list_drives"), invoke<Settings>("get_settings")])
      .then(([list, settings]) => {
        const skipped = settings.indexing.excluded_drives.map((d) => d.toUpperCase());
        drives.current = list.filter((d) => d.ntfs && !skipped.includes(d.letter.toUpperCase())).map((d) => d.letter);
      })
      .catch(() => {});
  }, []);

  /** 0–1 across every drive: each reads (the first half) and then saves (the second). */
  const overallOf = useCallback((p: IndexProgress) => {
    const list = drives.current;
    const at = list.findIndex((l) => p.drive.toUpperCase().startsWith(l.toUpperCase()));
    const own = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
    const within = p.phase === "reading" ? own * 0.5 : 0.5 + own * 0.5;
    const value = list.length > 0 && at >= 0 ? (at + within) / list.length : within;
    // Never backwards: a second drive starting must not pull the bar back.
    furthest.current = Math.max(furthest.current, value);
    return furthest.current;
  }, []);

  /** After the index (or skipping it): the choice about images, then done. */
  const showImages = useCallback(() => {
    backend
      .status()
      .then((s) => setStep({ kind: "images", count: s.file_count }))
      .catch(() => setStep({ kind: "images", count: 0 }));
  }, []);

  /** Image indexing on or off, as picked; on starts reading them (images.rs). */
  const chooseImages = async (on: boolean, count: number) => {
    if (on) {
      try {
        const settings = await invoke<Settings>("get_settings");
        await saveSettings({ ...settings, images: { ...settings.images, enabled: true } });
      } catch {
        // Not saved: it can be turned on in settings.
        on = false;
      }
    }
    setStep({ kind: "done", count, images: on });
  };

  /** Shows the drive choice if the index's drive is short of space (always,
   *  with a message saying what went wrong) and resolves false; true if
   *  there's room, or the space couldn't be read. */
  const checkSpace = useCallback(async (message?: string) => {
    try {
      const [location, list] = await Promise.all([indexLocation(), invoke<Drive[]>("list_drives")]);
      if (!message && location.free_bytes >= location.needed_bytes) return true;
      setStep({ kind: "space", location, drives: list, message });
      return false;
    } catch {
      return true; // couldn't tell: the backend checks again before indexing
    }
  }, []);

  useEffect(
    () =>
      backend.onEvent((e) => {
        if (e.type === "index_progress") setStep({ kind: "indexing", progress: e.progress, overall: overallOf(e.progress) });
        else if (e.type === "index_done") showImages();
        else if (e.code === "disk_full") {
          const message = "The drive ran out of space while saving the index.";
          checkSpace(message).then((unknown) => unknown && setStep({ kind: "error", message }));
        } else setStep({ kind: "error", message: e.error });
      }),
    [overallOf, showImages, checkSpace]
  );

  // Where things stand when the window opens: the backend starts with it, so
  // give it a moment. An index that already exists means there's nothing to do.
  useEffect(() => {
    if (PREVIEW) return; // stay on the screen asked for
    const look = () =>
      backend.status().then((s) => {
        if (s.indexing) setStep((st) => (st.kind === "indexing" ? st : { kind: "indexing", overall: furthest.current }));
        else if (s.indexed_at > 0) setStep({ kind: "images", count: s.file_count });
      });
    look().catch(() => setTimeout(() => look().catch(() => {}), 800));
  }, []);

  const start = async () => {
    // Before Windows' prompt: a full drive would only fail minutes in.
    if (!(await checkSpace())) return;
    setStep({ kind: "asking" });
    furthest.current = 0;
    try {
      await backend.reindex();
      setStep((st) => (st.kind === "asking" ? { kind: "indexing", overall: 0 } : st));
    } catch (err) {
      if (err instanceof BackendError && err.code === "admin_denied") {
        setStep({ kind: "allow", message: "Windows permission was declined. Better Search can't search your drives without it." });
      } else if (err instanceof BackendError && err.code === "busy") {
        setStep({ kind: "indexing", overall: furthest.current });
      } else if (err instanceof BackendError && err.code === "disk_full") {
        const message = "There isn't enough free space to build the index.";
        if (await checkSpace(message)) setStep({ kind: "error", message });
      } else {
        setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  };


  const at = stepOf(step);

  return (
    // The padding is transparent window, room for the shadow (lib.rs sizes
    // the window to match).
    <div className="h-screen w-screen p-6">
    <div
      className="dark flex size-full overflow-hidden rounded-[14px] bg-black text-white select-none"
      style={{ boxShadow: panelShadow }}
    >
      {/* Left half: the step itself, on the settings home's red. */}
      <div className="relative isolate flex w-1/2 flex-col overflow-hidden">
        <ArcBands />

        <header data-tauri-drag-region className="flex shrink-0 px-8 pt-8">
          <div className="pointer-events-none flex items-center gap-2">
            <img src="/logo.svg" alt="" className="size-3.5 invert" />
            <span className="font-pixel text-[12px] leading-none">better-search</span>
          </div>
        </header>

        <main className="flex flex-1 flex-col justify-end px-8 pb-8">
          <div key={at} className="flex flex-col items-start gap-4 motion-safe:animate-fade-in">
            {step.kind === "allow" || step.kind === "asking" ? (
              <Permission step={step} onAllow={start} onSkip={showImages} />
            ) : step.kind === "space" ? (
              <Space step={step} onContinue={start} onSkip={showImages} />
            ) : step.kind === "indexing" ? (
              <Indexing step={step} />
            ) : step.kind === "images" ? (
              <Images onChoose={(on) => chooseImages(on, step.count)} />
            ) : step.kind === "done" ? (
              <Success count={step.count} images={step.images} />
            ) : (
              <Failed message={step.message} onRetry={start} onSkip={showImages} />
            )}
          </div>
        </main>
      </div>

      {/* Right half: how far along setup is. */}
      <div data-tauri-drag-region className="flex w-1/2 items-center justify-center">
        <MilestoneRail
          steps={STEPS}
          // Finished steps: all of them once done. While indexing, the bar
          // also moves through the indexing step as the drives are read.
          done={step.kind === "done" ? STEPS.length : at}
          percent={step.kind === "indexing" ? ((1 + step.overall) / STEPS.length) * 100 : undefined}
          className="w-44"
        />
      </div>
    </div>
    </div>
  );
}

/** Every screen's heading and the line or two under it. */
function Intro({ title, children, alert }: { title: string; children: ReactNode; alert?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="max-w-60 text-[20px] leading-[22px] font-semibold tracking-tight">{title}</h1>
      <p role={alert ? "alert" : undefined} className="max-w-65 text-[12px] leading-4 text-white/85">
        {children}
      </p>
    </div>
  );
}

/** Something went wrong, in a box that reads on the red. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="max-w-65 rounded-md bg-black/35 px-2.5 py-1.5 text-[11px] leading-4 text-white">
      {children}
    </p>
  );
}

const button = cn(
  "flex h-8 items-center rounded-lg px-4 text-[12px] leading-4 font-medium transition-[filter,translate,box-shadow] duration-150",
  "hover:brightness-110 active:translate-y-px disabled:pointer-events-none disabled:opacity-60",
  "outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#5a0b0b]"
);
/** The step's own action: dark on the red, lit along its top edge. */
const primary = cn(
  button,
  "bg-linear-to-b from-[#4f0b0c] to-[#2b0304] text-white",
  "shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_0_0_1px_rgb(0_0_0/0.45),0_2px_4px_rgb(0_0_0/0.3),0_8px_16px_-4px_rgb(0_0_0/0.5)]",
  "active:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_0_0_1px_rgb(0_0_0/0.45),0_1px_2px_rgb(0_0_0/0.3)]"
);
/** Skipping, or the way back: light on the red. */
const secondary = cn(
  button,
  "bg-linear-to-b from-white to-[#f2d6d6] text-[#3b0607]",
  "shadow-[inset_0_1px_0_rgb(255_255_255/0.9),0_0_0_1px_rgb(0_0_0/0.18),0_2px_4px_rgb(0_0_0/0.2),0_8px_16px_-4px_rgb(0_0_0/0.4)]",
  "active:shadow-[inset_0_1px_0_rgb(255_255_255/0.9),0_0_0_1px_rgb(0_0_0/0.18),0_1px_2px_rgb(0_0_0/0.2)]"
);

function Permission({ step, onAllow, onSkip }: { step: Step; onAllow: () => void; onSkip: () => void }) {
  const asking = step.kind === "asking";
  const message = step.kind === "allow" ? step.message : undefined;
  return (
    <>
      <Intro title="Allow administrator access">
        Better Search reads file names straight from your drives, so Windows will ask for permission next. Nothing leaves this computer.
      </Intro>
      {message && <Notice>{message}</Notice>}
      <div className="flex gap-2">
        <button type="button" onClick={onAllow} disabled={asking} className={primary}>
          {asking ? "waiting…" : message ? "try again" : "allow"}
        </button>
        <button type="button" onClick={onSkip} className={secondary}>
          skip
        </button>
      </div>
    </>
  );
}

function Space({ step, onContinue, onSkip }: { step: Extract<Step, { kind: "space" }>; onContinue: () => void; onSkip: () => void }) {
  const { location } = step;
  const others = roomyDrives(location, step.drives).filter((d) => d.letter !== location.drive);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Picking a drive is the go-ahead: move the index there and carry on. */
  const use = async (letter: string) => {
    setMoving(letter);
    setError(null);
    try {
      await moveIndex(letter);
      onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMoving(null);
    }
  };

  return (
    <>
      <Intro title={others.length > 0 ? `Your ${location.drive} drive is almost full` : "Not enough disk space"}>
        {step.message && `${step.message} `}
        Better Search needs about {diskSize(location.needed_bytes)} for its index, and {location.drive} has{" "}
        {diskSize(location.free_bytes)}.{" "}
        {others.length > 0 ? "Pick another drive to keep it on. It still searches all of them." : "Free up some space, then check again."}
      </Intro>
      {error && <Notice>{error}</Notice>}
      {others.length > 0 ? (
        // One square tile per drive, side by side.
        <div className="flex gap-2">
          {others.slice(0, 3).map((d) => (
            <button
              key={d.letter}
              type="button"
              onClick={() => use(d.letter)}
              disabled={moving !== null}
              aria-label={`Keep the index on ${d.label || "Local Disk"} (${d.letter}), ${diskSize(d.free_bytes)} free`}
              className={cn(
                "flex size-19 flex-col justify-between rounded-xl bg-black/35 p-2 text-left ring-1 transition-colors hover:bg-black/50 disabled:pointer-events-none",
                moving === d.letter ? "ring-white/60" : "ring-white/5",
                moving !== null && moving !== d.letter && "opacity-50"
              )}
            >
              <HardDriveIcon size={14} className="text-white/70" />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] leading-4 font-semibold">{d.letter}</span>
                <span className="truncate text-[10px] leading-3 text-white/70 tabular-nums">
                  {moving === d.letter ? "Moving…" : `${diskSize(d.free_bytes)} free`}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <button type="button" onClick={onContinue} className={primary}>
          check again
        </button>
      )}
      <button type="button" onClick={onSkip} disabled={moving !== null} className={secondary}>
        skip
      </button>
    </>
  );
}

function Indexing({ step }: { step: Extract<Step, { kind: "indexing" }> }) {
  const pct = Math.min(99, Math.round(step.overall * 100));
  const p = step.progress;
  return (
    <>
      <Intro title="Indexing your drives">This can take a few minutes on large drives. Keep this window open.</Intro>
      <div className="flex w-65 flex-col gap-2">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Indexing progress"
          className="h-1 w-full overflow-hidden rounded-full bg-black/35"
        >
          <div className="ob-bar h-full rounded-full bg-white transition-[width] duration-500 ease-out" style={{ width: `${Math.max(pct, 3)}%` }} />
        </div>
        <div className="flex items-baseline justify-between text-[11px] leading-4 tabular-nums">
          <span className="text-white/75">{p ? `${p.phase === "reading" ? "Reading" : "Saving"} ${p.drive}` : "Starting…"}</span>
          <span className="font-semibold">{pct}%</span>
        </div>
      </div>
    </>
  );
}

/** Whether to read the text in screenshots and photos, so a content search
 *  finds them. Off unless picked: it takes a while and some space. */
function Images({ onChoose }: { onChoose: (on: boolean) => void }) {
  const [saving, setSaving] = useState(false);
  return (
    <>
      <span className="flex size-9 items-center justify-center rounded-xl bg-black/35 ring-1 ring-white/10">
        <FileImageIcon size={18} />
      </span>
      <Intro title="Search the text in your images?">
        Better Search can read the words in your screenshots and photos with Windows' own text recognition, so{" "}
        <span className="font-semibold text-white">\ elasticity</span> finds that quiz screenshot. It reads your Desktop,
        Documents, Pictures and Downloads in the background. Nothing leaves this computer, and you can turn it off or
        delete it in Settings.
      </Intro>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            onChoose(true);
          }}
          className={primary}
        >
          index images
        </button>
        <button type="button" disabled={saving} onClick={() => onChoose(false)} className={secondary}>
          not now
        </button>
      </div>
    </>
  );
}

function Success({ count, images }: { count: number; images: boolean }) {
  return (
    <>
      <Intro title="You're all set">
        {count > 0 ? `${count.toLocaleString()} files and folders are ready to search. ` : "Your drives are indexed and ready to search. "}
        {images && "Your images are being read in the background. "}
        Press <span className="font-semibold text-white">Alt + S</span> anywhere to search.
      </Intro>
      <button type="button" onClick={finish} className={primary} autoFocus>
        start searching
      </button>
    </>
  );
}

function Failed({ message, onRetry, onSkip }: { message: string; onRetry: () => void; onSkip: () => void }) {
  return (
    <>
      <Intro title="Indexing didn't finish" alert>
        {message}
      </Intro>
      <div className="flex gap-2">
        <button type="button" onClick={onRetry} className={primary}>
          try again
        </button>
        <button type="button" onClick={onSkip} className={secondary}>
          skip
        </button>
      </div>
    </>
  );
}
