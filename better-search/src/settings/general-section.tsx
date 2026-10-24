import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { ArrowCounterClockwiseIcon, MinusIcon, PlusIcon, PowerIcon } from "@/lib/phosphor";
import { DEFAULT_SETTINGS, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, type Settings } from "@/lib/settings";
import { shortcutPill } from "@/lib/surface-classes";
import { ActionButton, Group, Row, Switch } from "@/settings/controls";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

export function GeneralSection({ settings, save }: { settings: Settings; save: Save }) {
  return (
    <>
      <Group>
        <LaunchAtStartupRow />
        <ShortcutRow shortcut={settings.shortcut} save={save} />
        <UiScaleRow scale={settings.ui_scale} save={save} />
      </Group>
      <Group footer="Better Search keeps running in the background so the shortcut works. Quitting stops it until you open it again.">
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
  "flex size-7 items-center justify-center rounded-md bg-white/[0.07] text-white transition-colors hover:bg-white/[0.11] disabled:pointer-events-none disabled:opacity-40";

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
    <Row label="Interface size" description="Makes the search bar, results and preview bigger or smaller." error={error}>
      {percent !== 100 && (
        <ActionButton aria-label="Reset to 100%" onClick={() => apply(1)}>
          <ArrowCounterClockwiseIcon size={14} />
          Reset
        </ActionButton>
      )}
      <button
        type="button"
        aria-label="Smaller"
        disabled={percent <= UI_SCALE_MIN * 100}
        onClick={() => apply(scale - UI_SCALE_STEP)}
        className={stepButton}
      >
        <MinusIcon size={14} />
      </button>
      <span aria-live="polite" className="w-9 text-center text-[11px] leading-4 text-white tabular-nums">
        {percent}%
      </span>
      <button
        type="button"
        aria-label="Bigger"
        disabled={percent >= UI_SCALE_MAX * 100}
        onClick={() => apply(scale + UI_SCALE_STEP)}
        className={stepButton}
      >
        <PlusIcon size={14} />
      </button>
    </Row>
  );
}

const MODIFIER_NAMES: Record<string, string> = { Control: "Ctrl", Super: "Win", CommandOrControl: "Ctrl", Ctrl: "Ctrl" };

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

function keysOf(accelerator: string) {
  return accelerator.split("+").map((k) => MODIFIER_NAMES[k] ?? k.replace(/^Arrow/, ""));
}

function ShortcutRow({ shortcut, save }: { shortcut: string; save: Save }) {
  const [recording, setRecording] = useState(false);
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
    if (!recording) return;
    getCurrentWindow()
      .setFocus()
      .catch(() => {});
    buttonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
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
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording]);

  return (
    <Row
      label="Shortcut"
      description={
        recording ? (
          <>
            Press a combination with Ctrl, Alt or Win, like <span className={shortcutPill}>Ctrl + Space</span> or{" "}
            <span className={shortcutPill}>Alt + Q</span>. <span className={shortcutPill}>Esc</span> cancels.
          </>
        ) : (
          "Opens and closes the search from anywhere."
        )
      }
      error={error}
    >
      {shortcut !== DEFAULT_SETTINGS.shortcut && !recording && (
        <ActionButton
          aria-label={`Reset to ${keysOf(DEFAULT_SETTINGS.shortcut).join("+")}`}
          onClick={() => apply(DEFAULT_SETTINGS.shortcut)}
        >
          <ArrowCounterClockwiseIcon size={14} />
          Reset to {keysOf(DEFAULT_SETTINGS.shortcut).join(" + ")}
        </ActionButton>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setError(null);
          setRecording((r) => !r);
        }}
        onBlur={() => setRecording(false)}
        aria-label={recording ? "Recording shortcut" : `Change shortcut, currently ${keysOf(shortcut).join(" ")}`}
        className={
          "flex h-7 items-center justify-center gap-1 rounded-md px-2.5 text-[11px] leading-4 transition-colors " +
          (recording ? "bg-[#6B97FF]/15 text-[#9DB9FF] ring-1 ring-[#6B97FF]/60" : "bg-white/[0.07] hover:bg-white/[0.11]")
        }
      >
        {recording ? (
          "Press keys…"
        ) : (
          // Plain text: the button is already a key-like chip, caps inside it
          // would be boxes in a box.
          <span className="font-medium text-zinc-100">{keysOf(shortcut).join(" + ")}</span>
        )}
      </button>
    </Row>
  );
}
