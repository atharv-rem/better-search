import { useEffect, useState } from "react";
import { ArrowCounterClockwiseIcon } from "@/lib/phosphor";
import { DEFAULT_WEB_TRIGGER, type Settings } from "@/lib/settings";
import { shortcutPill } from "@/lib/surface-classes";
import { ActionButton, Group, Row } from "@/settings/controls";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

export function ShortcutsSection({ settings, save }: { settings: Settings; save: Save }) {
  return (
    <Group footer="Type it at the start of a search, then your question. The search bar's hint changes to match.">
      <WebTriggerRow trigger={settings.web.trigger} save={save} />
    </Group>
  );
}

function WebTriggerRow({ trigger, save }: { trigger: string; save: Save }) {
  const [draft, setDraft] = useState(trigger);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(trigger), [trigger]);

  const apply = async (next: string) => {
    next = next.trim();
    if (next === trigger) return setDraft(trigger);
    const err = await save((s) => ({ ...s, web: { ...s.web, trigger: next } }));
    setError(err);
    if (err) setDraft(trigger);
  };

  return (
    <Row
      label="Web search"
      description={
        <>
          Start a search with <span className={shortcutPill}>{trigger}</span> to search the web. One or two symbols.
        </>
      }
      error={error}
    >
      {trigger !== DEFAULT_WEB_TRIGGER && (
        <ActionButton aria-label={`Reset to ${DEFAULT_WEB_TRIGGER}`} onClick={() => apply(DEFAULT_WEB_TRIGGER)}>
          <ArrowCounterClockwiseIcon size={14} />
          Reset to {DEFAULT_WEB_TRIGGER}
        </ActionButton>
      )}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => apply(draft)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        maxLength={2}
        aria-label="Web search shortcut"
        spellCheck={false}
        className="h-7 w-14 rounded-md bg-white/[0.07] px-2.5 text-center text-[11px] leading-4 text-white outline-hidden focus:ring-1 focus:ring-[#6B97FF]"
      />
    </Row>
  );
}
