import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  FileMagnifyingGlassIcon,
  FolderOpenIcon,
  HardDriveIcon,
  LockSimpleIcon,
  ShieldCheckIcon,
  type IconProps,
} from "@/lib/phosphor";
import { backend, BackendError, type IndexProgress } from "@/lib/backend";
import { saveSettings, type Settings } from "@/lib/settings";
import { diskSize, indexLocation, moveIndex, roomyDrives, type Drive, type IndexLocation } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { shortcutPill } from "@/lib/surface-classes";

type Step =
  | { kind: "allow"; message?: string }
  // The index's drive is short of space: pick another, or free some up.
  | { kind: "space"; location: IndexLocation; drives: Drive[]; message?: string }
  | { kind: "asking" } // the Windows permission prompt is open
  | { kind: "indexing"; progress?: IndexProgress; overall: number }
  | { kind: "done"; count: number }
  | { kind: "error"; message: string };

const STEPS = ["Permission", "Indexing", "Done"] as const;

const stepOf = (step: Step) =>
  step.kind === "allow" || step.kind === "asking" || step.kind === "space" || step.kind === "error" ? 0 : step.kind === "indexing" ? 1 : 2;

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

export function OnboardingWindow() {
  const [step, setStep] = useState<Step>({ kind: "allow" });
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

  const showDone = useCallback(() => {
    backend
      .status()
      .then((s) => setStep({ kind: "done", count: s.file_count }))
      .catch(() => setStep({ kind: "done", count: 0 }));
  }, []);

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
        else if (e.type === "index_done") showDone();
        else if (e.code === "disk_full") {
          const message = "The drive ran out of space while saving the index.";
          checkSpace(message).then((unknown) => unknown && setStep({ kind: "error", message }));
        } else setStep({ kind: "error", message: e.error });
      }),
    [overallOf, showDone, checkSpace]
  );

  // Where things stand when the window opens: the backend starts with it, so
  // give it a moment. An index that already exists means there's nothing to do.
  useEffect(() => {
    const look = () =>
      backend.status().then((s) => {
        if (s.indexing) setStep((st) => (st.kind === "indexing" ? st : { kind: "indexing", overall: furthest.current }));
        else if (s.indexed_at > 0) setStep({ kind: "done", count: s.file_count });
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
    <div className="dark relative flex h-screen w-screen flex-col overflow-hidden rounded-[14px] bg-black text-white select-none">
      <div aria-hidden="true" className="ob-glow pointer-events-none absolute inset-x-0 bottom-0 h-3/5" />
      <div aria-hidden="true" className="ob-dots pointer-events-none absolute inset-0" />

      <header data-tauri-drag-region className="relative z-10 flex h-14 shrink-0 items-center justify-between px-6">
        <div className="pointer-events-none flex items-center gap-2">
          <img src="/logo.svg" alt="" className="size-4 invert" />
          <span className="font-pixel text-[13px] leading-none">better-search</span>
        </div>
        <ol className="pointer-events-none flex items-center gap-2 text-[11px] leading-4" aria-label="Progress">
          {STEPS.map((name, i) => (
            <li key={name} aria-current={i === at ? "step" : undefined} className="flex items-center gap-2">
              {i > 0 && <span className={cn("h-px w-5 transition-colors duration-300", i <= at ? "bg-white/60" : "bg-white/15")} />}
              <span className={cn("flex items-center gap-1.5 transition-colors duration-300", i === at ? "text-white" : i < at ? "text-zinc-300" : "text-zinc-600")}>
                <span
                  className={cn(
                    "size-1.5 rounded-full transition-colors duration-300",
                    i === at ? "bg-white" : i < at ? "bg-white/60" : "bg-white/15"
                  )}
                />
                {name}
              </span>
            </li>
          ))}
        </ol>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-10 pb-10">
        <div key={at} className="flex w-full max-w-[420px] flex-col items-center gap-6 text-center motion-safe:animate-fade-in">
          {step.kind === "allow" || step.kind === "asking" ? (
            <Permission step={step} onAllow={start} onSkip={finish} />
          ) : step.kind === "space" ? (
            <Space step={step} onContinue={start} />
          ) : step.kind === "indexing" ? (
            <Indexing step={step} />
          ) : step.kind === "done" ? (
            <Success count={step.count} />
          ) : (
            <Failed message={step.message} onRetry={start} />
          )}
        </div>
      </main>
    </div>
  );
}

function Badge({ icon: Icon }: { icon: ComponentType<IconProps> }) {
  return (
    <span className="flex size-12 items-center justify-center rounded-2xl bg-white/[0.07] ring-1 ring-white/10">
      <Icon size={24} weight="duotone" />
    </span>
  );
}

const primary =
  "flex h-9 items-center justify-center gap-2 rounded-lg bg-white px-5 text-[13px] leading-4 font-medium text-black transition-colors hover:bg-white/90 disabled:pointer-events-none disabled:opacity-60";

function Permission({ step, onAllow, onSkip }: { step: Step; onAllow: () => void; onSkip: () => void }) {
  const asking = step.kind === "asking";
  const message = step.kind === "allow" ? step.message : undefined;
  return (
    <>
      <Badge icon={ShieldCheckIcon} />
      <div className="flex flex-col gap-2">
        <h1 className="text-[20px] leading-6 font-semibold">Allow administrator access</h1>
        <p className="text-[13px] leading-5 text-zinc-400">
          To make every search instant, Better Search reads each drive&apos;s file list directly. Windows needs your permission for that, and
          will ask you next.
        </p>
      </div>
      <ul className="flex w-full flex-col gap-2 text-left text-[12px] leading-4 text-zinc-300">
        {(
          [
            [FileMagnifyingGlassIcon, "It reads file and folder names, not what's inside them."],
            [LockSimpleIcon, "The index stays on this computer."],
            [FolderOpenIcon, "You can exclude drives and folders later, in settings."],
          ] as const
        ).map(([Icon, text]) => (
          <li key={text} className="flex items-center gap-3 rounded-lg bg-white/[0.04] px-3 py-2.5 ring-1 ring-white/[0.06]">
            <Icon size={16} className="shrink-0 text-zinc-400" />
            {text}
          </li>
        ))}
      </ul>
      {message && (
        <p role="alert" className="text-[12px] leading-4 text-amber-300/90">
          {message}
        </p>
      )}
      <div className="flex flex-col items-center gap-2">
        <button type="button" onClick={onAllow} disabled={asking} className={primary}>
          {asking ? "Waiting for permission…" : message ? "Try again" : "Allow and index"}
        </button>
        <button type="button" onClick={onSkip} className="text-[12px] leading-4 text-zinc-500 transition-colors hover:text-zinc-300">
          Skip for now
        </button>
      </div>
    </>
  );
}

function Space({ step, onContinue }: { step: Extract<Step, { kind: "space" }>; onContinue: () => void }) {
  const { location } = step;
  const others = roomyDrives(location, step.drives).filter((d) => d.letter !== location.drive);
  const [choice, setChoice] = useState(others[0]?.letter);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async () => {
    if (!choice) return;
    setMoving(true);
    setError(null);
    try {
      await moveIndex(choice);
      onContinue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMoving(false);
    }
  };

  return (
    <>
      <Badge icon={HardDriveIcon} />
      <div className="flex flex-col gap-2">
        <h1 className="text-[20px] leading-6 font-semibold">
          {others.length > 0 ? `Your ${location.drive} drive is almost full` : "Not enough disk space"}
        </h1>
        <p className="text-[13px] leading-5 text-zinc-400">
          {step.message && `${step.message} `}
          Better Search needs about {diskSize(location.needed_bytes)} free for its search index, and {location.drive} has{" "}
          {diskSize(location.free_bytes)}.{" "}
          {others.length > 0
            ? "Keep the index on another drive instead. It still searches all of them."
            : "Free up some space, then check again."}
        </p>
      </div>
      {others.length > 0 && (
        <div role="radiogroup" aria-label="Drive for the index" className="flex w-full flex-col gap-2 text-left text-[12px] leading-4">
          {others.slice(0, 3).map((d) => (
            <button
              key={d.letter}
              type="button"
              role="radio"
              aria-checked={choice === d.letter}
              onClick={() => setChoice(d.letter)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 ring-1 transition-colors",
                choice === d.letter
                  ? "bg-white/[0.09] text-white ring-white/40"
                  : "bg-white/[0.04] text-zinc-300 ring-white/[0.06] hover:bg-white/[0.07]"
              )}
            >
              <HardDriveIcon size={16} className="shrink-0 text-zinc-400" />
              <span className="flex-1 truncate">
                {d.label || "Local Disk"} ({d.letter})
              </span>
              <span className="shrink-0 text-zinc-400 tabular-nums">{diskSize(d.free_bytes)} free</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12px] leading-4 text-amber-300/90">
          {error}
        </p>
      )}
      <div className="flex flex-col items-center gap-2">
        {others.length > 0 ? (
          <button type="button" onClick={move} disabled={moving || !choice} className={primary}>
            {moving ? "Moving…" : `Use ${choice} and continue`}
          </button>
        ) : (
          <button type="button" onClick={onContinue} className={primary}>
            Check again
          </button>
        )}
        <button type="button" onClick={finish} className="text-[12px] leading-4 text-zinc-500 transition-colors hover:text-zinc-300">
          Skip for now
        </button>
      </div>
    </>
  );
}

function Indexing({ step }: { step: Extract<Step, { kind: "indexing" }> }) {
  const pct = Math.min(99, Math.round(step.overall * 100));
  const p = step.progress;
  return (
    <>
      <Badge icon={FileMagnifyingGlassIcon} />
      <div className="flex flex-col gap-2">
        <h1 className="text-[20px] leading-6 font-semibold">Indexing your drives</h1>
        <p className="text-[13px] leading-5 text-zinc-400">This can take a few minutes on large drives. Keep this window open.</p>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Indexing progress"
          className="h-2 w-full overflow-hidden rounded-full bg-white/10"
        >
          <div className="ob-bar h-full rounded-full bg-white transition-[width] duration-500 ease-out" style={{ width: `${Math.max(pct, 3)}%` }} />
        </div>
        <div className="flex items-baseline justify-between text-[12px] leading-4 tabular-nums">
          <span className="text-zinc-400">{p ? `${p.phase === "reading" ? "Reading" : "Saving"} ${p.drive}` : "Starting…"}</span>
          <span className="font-semibold text-white">{pct}%</span>
        </div>
      </div>
    </>
  );
}

function Success({ count }: { count: number }) {
  return (
    <>
      <svg viewBox="0 0 56 56" className="size-14" fill="none" aria-hidden="true">
        <circle className="ob-ring" cx="28" cy="28" r="26" stroke="currentColor" strokeWidth="2" />
        <path className="ob-check" d="M17 29.5l7.5 7.5L39 20.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="flex flex-col gap-2">
        <h1 className="text-[20px] leading-6 font-semibold">You&apos;re all set</h1>
        <p className="text-[13px] leading-5 text-zinc-400">
          {count > 0 ? (
            <>
              <span className="font-semibold text-white">{count.toLocaleString()}</span> files and folders are ready to search.
            </>
          ) : (
            "Your drives are indexed and ready to search."
          )}
        </p>
      </div>
      <p className="flex items-center gap-1 text-[13px] leading-5 text-zinc-300">
        Press <span className={shortcutPill}>Alt + S</span> anywhere to search.
      </p>
      <button type="button" onClick={finish} className={primary} autoFocus>
        Start searching
      </button>
    </>
  );
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <>
      <Badge icon={ShieldCheckIcon} />
      <div className="flex flex-col gap-2">
        <h1 className="text-[20px] leading-6 font-semibold">Indexing didn&apos;t finish</h1>
        <p role="alert" className="text-[13px] leading-5 text-zinc-400">
          {message}
        </p>
      </div>
      <div className="flex flex-col items-center gap-2">
        <button type="button" onClick={onRetry} className={primary}>
          Try again
        </button>
        <button type="button" onClick={finish} className="text-[12px] leading-4 text-zinc-500 transition-colors hover:text-zinc-300">
          Skip for now
        </button>
      </div>
    </>
  );
}
