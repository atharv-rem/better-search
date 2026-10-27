import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { ArrowCounterClockwiseIcon, MinusIcon, PlusIcon, PowerIcon } from "@/lib/phosphor";
import { DEFAULT_SETTINGS, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, type Settings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ActionButton, Group, Keys, keysOf, Row, Switch } from "@/settings/controls";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

export function GeneralSection({ settings, save }: { settings: Settings; save: Save }) {
  return (
    <>
      <Group title="Shortcut">
        <ShortcutCard shortcut={settings.shortcut} save={save} />
      </Group>
      <Group title="Startup">
        <LaunchAtStartupRow />
      </Group>
      <Group title="Appearance">
        <UiScaleRow scale={settings.ui_scale} save={save} />
      </Group>
      <Group title="App" footer="Better Search keeps running in the background so the shortcut works. Quitting stops it until you open it again.">
        <Row label="Quit Better Search">
          <ActionButton variant="danger" onClick={() => invoke("quit_app")}>
            <PowerIcon size={14} />
            Quit
          </ActionButton>
        </Row>
      </Group>
    </>
  );
}

/** Windows' own startup list (HKCU\...\Run), not settings.json. */
function LaunchAtStartupRow() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    autostartEnabled()
      .then(setEnabled)
      .catch(() => setEnabled(false));
  }, []);

  const toggle = async (on: boolean) => {
    setEnabled(on);
    try {
      await (on ? enableAutostart() : disableAutostart());
      setError(null);
    } catch (err) {
      setEnabled(!on);
      setError(String(err));
    }
  };

  return (
    <Row label="Launch at startup" description="Start Better Search when you sign in to Windows." error={error}>
      <Switch checked={enabled ?? false} disabled={enabled === null} onChange={toggle} label="Launch at startup" />
    </Row>
  );
}

const stepButton =
  "flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.07] text-white transition-colors hover:bg-white/[0.11] disabled:pointer-events-none disabled:opacity-40";

/** Every size the steps reach: 70%, 80%, ... 150%. */
const UI_SCALES = Array.from(
  { length: Math.round((UI_SCALE_MAX - UI_SCALE_MIN) / UI_SCALE_STEP) + 1 },
  (_, i) => Math.round((UI_SCALE_MIN + i * UI_SCALE_STEP) * 100)
);

/** The search window's zoom, in steps; the window refits to it. */
function UiScaleRow({ scale, save }: { scale: number; save: Save }) {
  const [error, setError] = useState<string | null>(null);
  const percent = Math.round(scale * 100);
  const apply = async (next: number) => {
    // Rounded to the step, so repeated presses don't drift (0.1 + 0.2...).
    const rounded = Math.round(next / UI_SCALE_STEP) * UI_SCALE_STEP;
    setError(await save((s) => ({ ...s, ui_scale: Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, rounded)) })));
  };

  return (
    <div>
      <Row label="Interface size" description="Makes the search bar, results and preview bigger or smaller." error={error}>
        {percent !== 100 && (
          <ActionButton aria-label="Reset to 100%" onClick={() => apply(1)}>
            <ArrowCounterClockwiseIcon size={14} />
            Reset
          </ActionButton>
        )}
        <span aria-live="polite" className="w-10 text-right text-[12px] leading-4 font-medium text-white tabular-nums">
          {percent}%
        </span>
      </Row>
      <div className="flex items-center gap-3 px-3.5 pb-3.5">
        <button
          type="button"
          aria-label="Smaller"
          disabled={percent <= UI_SCALE_MIN * 100}
          onClick={() => apply(scale - UI_SCALE_STEP)}
          className={stepButton}
        >
          <MinusIcon size={14} />
        </button>
        {/* One bar per size, taller as it grows: the sizes up to the current
            one are lit, like a volume meter. */}
        <div role="radiogroup" aria-label="Interface size" className="flex h-7 flex-1 items-end gap-1">
          {UI_SCALES.map((p, i) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={p === percent}
              aria-label={`${p}%`}
              title={`${p}%`}
              onClick={() => apply(p / 100)}
              className="group flex h-full flex-1 items-end"
            >
              <span
                className={cn(
                  "w-full rounded-[3px] transition-colors duration-150",
                  p === percent ? "bg-white" : p < percent ? "bg-white/35 group-hover:bg-white/50" : "bg-white/[0.08] group-hover:bg-white/20",
                  p === 100 && p !== percent && "ring-1 ring-white/20"
                )}
                style={{ height: `${30 + (70 * i) / (UI_SCALES.length - 1)}%` }}
              />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Bigger"
          disabled={percent >= UI_SCALE_MAX * 100}
          onClick={() => apply(scale + UI_SCALE_STEP)}
          className={stepButton}
        >
          <PlusIcon size={14} />
        </button>
      </div>
    </div>
  );
}

/** The accelerator for a key press, like "Control+Shift+Space"; null for a
 *  press that can't be a shortcut (a modifier alone, or a plain key). */
function acceleratorOf(e: KeyboardEvent): string | null {
  const code = e.code;
  if (!code || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code)) return null;
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(
    Boolean
  ) as string[];
  const isFunctionKey = /^F\d{1,2}$/.test(code);
  // A plain letter would fire while typing anywhere; Shift alone barely helps.
  if (!isFunctionKey && (mods.length === 0 || (mods.length === 1 && mods[0] === "Shift"))) return null;
  const key = code.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, "");
  return [...mods, key].join("+");
}

/** The modifiers held during a key press, in the order a shortcut lists them. */
function heldOf(e: KeyboardEvent) {
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean) as string[];
}

/** The search's shortcut as large keycaps; clicking them records a new one. */
function ShortcutCard({ shortcut, save }: { shortcut: string; save: Save }) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The current shortcut is off while recording, so pressing it doesn't
  // open the search; back on when recording stops, however it stops.
  useEffect(() => {
    if (!recording) return;
    invoke("pause_shortcut", { paused: true }).catch(() => {});
    return () => {
      invoke("pause_shortcut", { paused: false }).catch(() => {});
    };
  }, [recording]);

  const apply = async (accelerator: string) => {
    setRecording(false);
    setError(await save((s) => ({ ...s, shortcut: accelerator })));
  };

  const applyRef = useRef(apply);
  applyRef.current = apply;

  // Keys are taken from the whole page, not just the button: they'd be lost
  // whenever the button didn't get keyboard focus from the click. The window
  // is focused too, in case the click didn't give it the keyboard.
  useEffect(() => {
    setHeld([]);
    if (!recording) return;
    getCurrentWindow()
      .setFocus()
      .catch(() => {});
    buttonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setHeld(heldOf(e));
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRecording(false);
        return;
      }
      const accelerator = acceleratorOf(e);
      if (accelerator) applyRef.current(accelerator);
      // A plain key on its own: say why nothing happened. Modifiers are still
      // being held down on their way to a combination, so not for those.
      else if (!/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code))
        setError("That key needs Ctrl, Alt or Win with it.");
    };
    const onKeyUp = (e: KeyboardEvent) => setHeld(heldOf(e));
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [recording]);

  const isDefault = shortcut === DEFAULT_SETTINGS.shortcut;
  const defaultKeys = keysOf(DEFAULT_SETTINGS.shortcut);

  return (
    <div className="flex flex-col items-center gap-3 px-3.5 pt-6 pb-4">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setError(null);
          setRecording((r) => !r);
        }}
        onBlur={() => setRecording(false)}
        aria-label={recording ? "Recording shortcut" : `Change shortcut, currently ${keysOf(shortcut).join(" ")}`}
        className={cn(
          "relative isolate flex h-[76px] min-w-56 items-center justify-center rounded-xl px-6 outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-[#6B97FF]",
          recording
            ? "bg-[#6B97FF]/[0.08] ring-1 ring-[#6B97FF]/50"
            : "bg-white/[0.02] ring-1 ring-white/[0.06] hover:bg-white/[0.04]"
        )}
      >
        {/* A soft glow under the keys. */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 -z-10 rounded-xl transition-opacity",
            recording
              ? "[background:radial-gradient(ellipse_60%_80%_at_50%_100%,rgba(107,151,255,0.22),transparent_70%)]"
              : "[background:radial-gradient(ellipse_60%_80%_at_50%_100%,rgba(255,255,255,0.06),transparent_70%)]"
          )}
        />
        {recording ? (
          <span className="flex items-center gap-2">
            {held.length > 0 && <Keys keys={held} size="lg" />}
            {/* Where the key that finishes the combination will go. */}
            <span className="flex h-11 min-w-11 items-center justify-center rounded-lg px-3.5 text-[13px] leading-5 text-[#9DB9FF] outline-1 -outline-offset-1 outline-[#6B97FF]/60 outline-dashed motion-safe:animate-pulse">
              {held.length ? "+ key" : "Press keys…"}
            </span>
          </span>
        ) : (
          <Keys keys={keysOf(shortcut)} size="lg" />
        )}
      </button>

      <div className="flex flex-col items-center gap-1 text-center">
        <span className="text-[12px] leading-4 text-white">
          {recording ? "Press the new combination" : "Opens and closes the search from anywhere"}
        </span>
        <span className="text-[11px] leading-4 text-zinc-500">
          {recording ? (
            <>
              Use Ctrl, Alt or Win with a key, like <Keys keys={["Ctrl", "Space"]} /> or <Keys keys={["Alt", "Q"]} />.{" "}
              <Keys keys={["Esc"]} /> cancels.
            </>
          ) : (
            "Click the keys to change it."
          )}
        </span>
        {error && (
          <span role="alert" className="text-[11px] leading-4 text-red-400">
            {error}
          </span>
        )}
      </div>

      {!isDefault && !recording && (
        <ActionButton aria-label={`Reset to ${defaultKeys.join("+")}`} onClick={() => apply(DEFAULT_SETTINGS.shortcut)}>
          <ArrowCounterClockwiseIcon size={14} />
          Reset to {defaultKeys.join(" + ")}
        </ActionButton>
      )}
    </div>
  );
}
