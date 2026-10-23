import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { ArrowCounterClockwiseIcon, PowerIcon } from "@phosphor-icons/react";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/settings";
import { ActionButton, Group, Kbd, Row, Switch } from "@/settings/controls";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

export function GeneralSection({ settings, save }: { settings: Settings; save: Save }) {
  return (
    <>
      <Group>
        <LaunchAtStartupRow />
        <ShortcutRow shortcut={settings.shortcut} save={save} />
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

const MODIFIER_NAMES: Record<string, string> = { Control: "Ctrl", Super: "Win", CommandOrControl: "Ctrl", Ctrl: "Ctrl" };

/** The accelerator for a key press, like "Control+Shift+Space"; null for a
 *  press that can't be a shortcut (a modifier alone, or a plain key). */
function acceleratorOf(e: ReactKeyboardEvent): string | null {
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

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      setRecording(false);
      return;
    }
    const accelerator = acceleratorOf(e);
    if (accelerator) apply(accelerator);
  };

  return (
    <Row
      label="Shortcut"
      description={recording ? "Press the new keys. Esc cancels." : "Opens and closes the search from anywhere."}
      error={error}
    >
      {shortcut !== DEFAULT_SETTINGS.shortcut && !recording && (
        <ActionButton aria-label="Reset to Alt+S" title="Reset to Alt+S" onClick={() => apply(DEFAULT_SETTINGS.shortcut)}>
          <ArrowCounterClockwiseIcon size={14} />
        </ActionButton>
      )}
      <button
        type="button"
        onClick={() => {
          setError(null);
          setRecording((r) => !r);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
        aria-label={recording ? "Recording shortcut" : `Change shortcut, currently ${keysOf(shortcut).join(" ")}`}
        className={
          "flex h-7 min-w-24 items-center justify-center gap-1 rounded-md px-2 text-[12px] leading-4 transition-colors " +
          (recording ? "bg-[#6B97FF]/15 text-[#9DB9FF] ring-1 ring-[#6B97FF]/60" : "bg-white/[0.07] hover:bg-white/[0.11]")
        }
      >
        {recording ? "Press keys…" : keysOf(shortcut).map((k, i) => <Kbd key={i}>{k}</Kbd>)}
      </button>
    </Row>
  );
}
