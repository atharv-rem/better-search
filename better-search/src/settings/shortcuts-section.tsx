import { Fragment, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AppWindowIcon,
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  FileMagnifyingGlassIcon,
  GlobeIcon,
  LinkIcon,
  MagnifyingGlassIcon,
} from "@/lib/phosphor";
import { DEFAULT_AI_TRIGGER, DEFAULT_CONTENT_TRIGGER, DEFAULT_WEB_TRIGGER, type Settings } from "@/lib/settings";
import { ActionButton, Group, Keys, keysOf, Row } from "@/settings/controls";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

/** The snap shortcut is fixed (SNAP_SHORTCUT in settings.rs). */
const SNAP_SHORTCUT = "Alt+W";

/** A keyboard shortcut and what it does, for the lists below. */
type Binding = { keys: readonly (readonly string[])[]; action: string };

const SNAP_KEYS: Binding[] = [
  { keys: [["←"], ["→"]], action: "Pick a layout, or a spot in it" },
  { keys: [["↑"], ["↓"]], action: "Move through the windows" },
  { keys: [["Enter"]], action: "Put the window in the spot" },
  { keys: [["Ctrl", "Enter"]], action: "Snap what's placed so far" },
  { keys: [["Esc"]], action: "Back to the layouts" },
];

export function ShortcutsSection({ settings, save }: { settings: Settings; save: Save }) {
  const reveals = settings.search.enter_reveals;
  const searchKeys: Binding[] = [
    { keys: [["↑"], ["↓"]], action: "Move through the results" },
    { keys: [["Enter"]], action: reveals ? "Show the result in Explorer" : "Open the result" },
    { keys: [["Ctrl", "Enter"]], action: reveals ? "Open the result" : "Show the result in Explorer" },
    { keys: [["Tab"], ["Shift", "Tab"]], action: "Switch the file type, or the browser in a web search" },
    { keys: [["Esc"]], action: "Close the search" },
  ];

  return (
    <>
      <Group title="Anywhere in Windows" footer="Change the search's shortcut in General.">
        <Row label="Search files" description="Opens and closes the search." icon={<MagnifyingGlassIcon size={18} />}>
          <Keys keys={keysOf(settings.shortcut)} />
        </Row>
        <Row label="Snap windows" description="Arranges your open windows into a layout." icon={<AppWindowIcon size={18} />}>
          <Keys keys={keysOf(SNAP_SHORTCUT)} />
        </Row>
      </Group>

      <Group
        title="Typed in the search bar"
        footer="Type it at the start of a search, then your question. The search bar's hint changes to match."
      >
        <TriggerRow
          label="Web search"
          what="the web search"
          trigger={settings.web.trigger}
          fallback={DEFAULT_WEB_TRIGGER}
          example="cats"
          does="to search the web"
          icon={<GlobeIcon size={18} />}
          save={(next) => save((s) => ({ ...s, web: { ...s.web, trigger: next } }))}
        />
        <TriggerRow
          label="File contents"
          what="the file contents search"
          trigger={settings.search.content_trigger}
          fallback={DEFAULT_CONTENT_TRIGGER}
          example="tax notes"
          does="to find files with those words inside, using Windows Search's index"
          icon={<FileMagnifyingGlassIcon size={18} />}
          save={(next) => save((s) => ({ ...s, search: { ...s.search, content_trigger: next } }))}
        >
          <ActionButton
            aria-label="Open Windows indexing options"
            title="Choose the folders Windows Search reads"
            onClick={() => invoke("open_indexing_options").catch((err) => console.error("Failed to open indexing options:", err))}
          >
            <ArrowSquareOutIcon size={14} />
            Indexed folders
          </ActionButton>
        </TriggerRow>
        <TriggerRow
          label="Ask AI"
          what="asking AI"
          trigger={settings.ai.trigger}
          fallback={DEFAULT_AI_TRIGGER}
          example="why is the sky blue"
          does="and press Enter to ask the AI chosen in API keys"
          icon={<span className="flex size-[18px] items-center justify-center text-[15px] leading-none font-medium">?</span>}
          save={(next) => save((s) => ({ ...s, ai: { ...s.ai, trigger: next } }))}
        />
        <Row
          label="Calculator"
          description={
            <>
              Start or end with = to work something out, like <Example>=12*4</Example>. <Keys keys={["Enter"]} /> copies the
              answer.
            </>
          }
          icon={<span className="flex size-[18px] items-center justify-center text-[15px] leading-none font-medium">=</span>}
        />
        <Row
          label="Websites"
          description={
            <>
              Type an address, like <Example>github.com</Example>, to open it in your browser.
            </>
          }
          icon={<LinkIcon size={18} />}
        />
      </Group>

      <Group title="In the search">
        <BindingList bindings={searchKeys} />
      </Group>

      <Group title="In snap mode">
        <BindingList bindings={SNAP_KEYS} />
      </Group>
    </>
  );
}

/** Something to type, in the search bar's look. */
function Example({ children }: { children: ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex h-5 items-center rounded-md bg-black px-1.5 align-middle font-mono text-[11px] leading-3 text-zinc-100 ring-1 ring-white/10">
      {children}
    </span>
  );
}

function BindingList({ bindings }: { bindings: Binding[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] py-1">
      {bindings.map(({ keys, action }) => (
        <div key={action} className="col-span-2 grid grid-cols-subgrid items-center gap-x-4 px-3.5 py-1.5">
          <dt className="text-[12px] leading-4 text-zinc-300">{action}</dt>
          <dd className="flex items-center justify-end gap-1.5 text-[11px] leading-4 text-zinc-600">
            {keys.map((k, i) => (
              <Fragment key={i}>
                {i > 0 && <span>{k.length > 1 || keys[0].length > 1 ? "or" : "/"}</span>}
                <Keys keys={k} />
              </Fragment>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A symbol typed at the start of a search to switch what it searches. */
function TriggerRow({
  label,
  what,
  trigger,
  fallback,
  example,
  does,
  icon,
  save,
  children,
}: {
  label: string;
  /** For the input's label: "the web search". */
  what: string;
  trigger: string;
  /** The default, which the reset button puts back. */
  fallback: string;
  example: string;
  does: string;
  icon: ReactNode;
  save: (next: string) => Promise<string | null>;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState(trigger);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(trigger), [trigger]);

  const apply = async (next: string) => {
    next = next.trim();
    if (next === trigger) return setDraft(trigger);
    const err = await save(next);
    setError(err);
    if (err) setDraft(trigger);
  };

  return (
    <Row
      label={label}
      description={
        <>
          Start a search with <Example>{trigger} {example}</Example> {does}. One or two symbols.
        </>
      }
      error={error}
      icon={icon}
    >
      {children}
      {trigger !== fallback && (
        <ActionButton aria-label={`Reset to ${fallback}`} onClick={() => apply(fallback)}>
          <ArrowCounterClockwiseIcon size={14} />
          Reset to {fallback}
        </ActionButton>
      )}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => apply(draft)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        maxLength={2}
        aria-label={`Shortcut for ${what}`}
        spellCheck={false}
        className="h-7 w-14 rounded-md bg-white/[0.07] px-2.5 text-center font-mono text-[13px] leading-4 font-medium text-white outline-hidden transition-colors hover:bg-white/[0.11] focus:bg-white/[0.11] focus:ring-1 focus:ring-[#6B97FF]"
      />
    </Row>
  );
}
