import { type ClipboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CheckIcon,
  ClipboardTextIcon,
  EyeIcon,
  EyeSlashIcon,
  GlobeIcon,
  TrashIcon,
} from "@/lib/phosphor";
import type { Settings } from "@/lib/settings";
import { describeUsage, PROVIDERS, useApiKeys, useUsage, type KeyStatus, type ProviderId } from "@/lib/web-search";
import { AI_KEY_PROVIDERS, AI_PROVIDERS, useAiKeys, useAiModels, type AiProvider, type AiProviderId } from "@/lib/ai";
import { ActionButton, Group, Row, Select, Switch } from "@/settings/controls";
import { shortcutPill } from "@/lib/surface-classes";
import { keepOpenFor } from "@/settings/keep-open";
import { cn } from "@/lib/utils";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

export function ApiKeysSection({ settings, save }: { settings: Settings; save: Save }) {
  const { keys, save: saveKey, remove } = useApiKeys();
  const [providerError, setProviderError] = useState<string | null>(null);
  const withKey = PROVIDERS.filter((p) => keys?.some((k) => k.provider === p.id && k.hint));

  const chooseProvider = async (provider: Settings["web"]["provider"]) =>
    setProviderError(await save((s) => ({ ...s, web: { ...s.web, provider } })));

  return (
    <>
      <Group
        title="Web search"
        footer={
          withKey.length === 0
            ? "Add a key below to see web results right here instead of in your browser."
            : (
              <>
                <span className={shortcutPill}>Enter</span> on a result opens it in your browser. <span className={shortcutPill}>Ctrl + Enter</span> searches in the browser instead.
              </>
            )
        }
      >
        <Row
          label="Web results"
          description="Where a search that starts with / shows its results."
          error={providerError}
        >
          <Select
            label="Web results"
            value={withKey.some((p) => p.id === settings.web.provider) ? settings.web.provider : "browser"}
            options={[
              {
                value: "browser" as const,
                label: "Open in browser",
                icon: <GlobeIcon size={14} />,
              },
              ...withKey.map((p) => ({
                value: p.id,
                label: p.name,
                icon: (
                  <span className="grid size-3.5 shrink-0 place-items-center rounded-[3px] bg-white">
                    <img src={p.logo} alt="" className="size-2.5 object-contain" draggable={false} />
                  </span>
                ),
              })),
            ]}
            onChange={chooseProvider}
          />
        </Row>
      </Group>
      <section className="flex flex-col gap-2">
        <KeyEditor
          title="Your web search keys"
          providers={PROVIDERS}
          keys={keys}
          onSave={(id, key) => saveKey(id as ProviderId, key)}
          onRemove={(id) => remove(id as ProviderId)}
          usage
          importPlaceholder={"# Paste KEY=value lines\nEXA_API_KEY=…\nFIRECRAWL_API_KEY=…"}
        />
        <p className="px-1 text-[11px] leading-4 text-zinc-500">
          Keys are kept in Windows Credential Manager and only sent to their own provider. Saving a key runs one small search to check it.
        </p>
      </section>
      <AiSection settings={settings} save={save} webProvider={withKey.find((p) => p.id === settings.web.provider)?.name ?? null} />
    </>
  );
}

/** An AI provider's logo, on the same white tile as the web results ones. */
function AiBadge({ provider }: { provider: Pick<AiProvider, "logo"> }) {
  return (
    <span className="grid size-3.5 shrink-0 place-items-center rounded-[3px] bg-white">
      <img src={provider.logo} alt="" className="size-2.5 object-contain" draggable={false} />
    </span>
  );
}

/** Which AI answers questions typed after "?", with which model, and the
 *  keys for the providers that need one. */
function AiSection({ settings, save, webProvider }: { settings: Settings; save: Save; webProvider: string | null }) {
  const { keys, save: saveKey, remove } = useAiKeys();
  const [error, setError] = useState<string | null>(null);
  const { ai } = settings;
  const usable = AI_PROVIDERS.filter((p) => p.local || keys?.some((k) => k.provider === p.id && k.hint));
  const chosen = usable.find((p) => p.id === ai.provider) ?? null;
  const models = useAiModels(chosen?.id ?? null, chosen !== null);
  const savedModel = chosen ? (ai.models[chosen.id] ?? "") : "";
  // The provider's models, with the saved one kept in case the list no
  // longer has it (or couldn't be fetched); "" is the provider's default.
  const modelOptions = [
    { value: "", label: chosen?.model ? `Default (${chosen.model})` : "Default" },
    ...[...(savedModel && !models?.list.includes(savedModel) ? [savedModel] : []), ...(models?.list ?? [])].map((m) => ({
      value: m,
      label: m,
    })),
  ];

  const setAi = async (change: Partial<Settings["ai"]>) => setError(await save((s) => ({ ...s, ai: { ...s.ai, ...change } })));

  const saveModel = (model: string) => {
    if (!chosen || model === savedModel) return;
    const next = { ...ai.models };
    if (model) next[chosen.id] = model;
    else delete next[chosen.id];
    setAi({ models: next });
  };

  return (
    <>
      <Group
        title="AI answers"
        footer={
          <>
            Start a search with <span className={shortcutPill}>{ai.trigger}</span> and press <span className={shortcutPill}>Enter</span> to ask. Change the symbol in Shortcuts.
          </>
        }
      >
        <Row label="Answers from" description="The AI that answers your questions." error={error}>
          <Select
            label="Answers from"
            value={chosen ? chosen.id : "off"}
            options={[
              { value: "off" as const, label: "Off" },
              ...usable.map((p) => ({ value: p.id, label: p.local ? `${p.name} (on this PC)` : p.name, icon: <AiBadge provider={p} /> })),
            ]}
            onChange={(provider) => setAi({ provider: provider as AiProviderId | "off" })}
          />
        </Row>
        {chosen && (
          <Row
            label="Model"
            description={
              models?.error
                ? `Couldn't list the models: ${models.error}`
                : models === null
                  ? "Loading the models…"
                  : chosen.model
                    ? `Default uses ${chosen.model}.`
                    : chosen.id === "openrouter"
                      ? "Default uses the first free model OpenRouter lists."
                      : `Default uses the first model ${chosen.name} has.`
            }
          >
            <Select label="Model" value={savedModel} options={modelOptions} onChange={saveModel} alwaysBelow />
          </Row>
        )}
        <Row
          label="Read the web first"
          description={
            webProvider
              ? `Search ${webProvider} for each question and answer from the results, with numbered sources you can hover. Uses a search's credits.`
              : "Choose a web results provider above to answer from the web, with numbered sources."
          }
        >
          <Switch
            checked={ai.web_sources && webProvider !== null}
            disabled={webProvider === null}
            onChange={(web_sources) => setAi({ web_sources })}
            label="Read the web first"
          />
        </Row>
      </Group>
      <section className="flex flex-col gap-2">
        <KeyEditor
          title="Your AI keys"
          providers={AI_KEY_PROVIDERS}
          keys={keys}
          onSave={saveKey}
          onRemove={remove}
          importPlaceholder={"# Paste KEY=value lines\nOPENAI_API_KEY=…\nGEMINI_API_KEY=…"}
        />
        <p className="px-1 text-[11px] leading-4 text-zinc-500">
          Providers marked free have a free tier with daily limits; some free tiers may use what you ask to train their models. Ollama and LM Studio run models on this PC and need no key. Saving a key checks it with the provider: for GitHub and Perplexity that's a one-word answer.
        </p>
      </section>
    </>
  );
}

// The keys as a table you edit in place, then save at once (after devl.dev's
// Env Editor): unsaved edits stay tinted, and pasting a .env fills in the keys
// it has. A saved key never comes back from the shell, so only unsaved ones
// can be revealed.

/** An unsaved edit: a new key to save, or the saved one to remove. */
type Change = { key: string } | { remove: true };

/** A provider in a keys table: a web search one or an AI one. */
interface KeyProvider {
  id: string;
  name: string;
  keyUrl: string;
  /** The variables a .env file keeps its key in. */
  env: readonly string[];
  /** Bundled, never fetched. */
  logo: string;
  /** Has a free tier. */
  free?: boolean;
}

const MASK = "••••••••";

/** The provider keys in a .env file's text, and how many lines weren't any. */
function parseDotenv(text: string, providers: readonly KeyProvider[]) {
  const found = new Map<string, string>();
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_]\w*)\s*=\s*(.*)$/);
    const provider = m && providers.find((p) => p.env.includes(m[1].toUpperCase()));
    let value = m?.[2].replace(/\s+#.*$/, "") ?? "";
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (provider && value) found.set(provider.id, value);
    else skipped++;
  }
  return { found, skipped };
}

function KeyEditor({
  title,
  providers,
  keys,
  onSave,
  onRemove,
  usage = false,
  importPlaceholder,
}: {
  title: string;
  providers: readonly KeyProvider[];
  /** Null while the keys load. */
  keys: KeyStatus[] | null;
  onSave: (provider: string, key: string) => Promise<string | null>;
  onRemove: (provider: string) => Promise<string | null>;
  /** Show what each saved key's account has used (web search providers). */
  usage?: boolean;
  importPlaceholder: string;
}) {
  const [changes, setChanges] = useState<Partial<Record<string, Change>>>({});
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const importBox = useRef<HTMLTextAreaElement>(null);

  const hint = (id: string) => keys?.find((k) => k.provider === id)?.hint ?? null;

  const counts = useMemo(() => {
    let added = 0;
    let replaced = 0;
    let removed = 0;
    for (const [id, c] of Object.entries(changes) as [string, Change][]) {
      if ("remove" in c) removed++;
      else if (keys?.find((k) => k.provider === id)?.hint) replaced++;
      else added++;
    }
    return { added, replaced, removed, total: added + replaced + removed };
  }, [changes, keys]);

  useEffect(() => {
    if (importOpen) importBox.current?.focus();
  }, [importOpen]);

  useEffect(() => {
    if (saving !== "saved") return;
    const t = setTimeout(() => setSaving("idle"), 1600);
    return () => clearTimeout(t);
  }, [saving]);

  const change = (id: string, c: Change | null) => {
    setChanges(({ [id]: _, ...rest }) => (c ? { ...rest, [id]: c } : rest));
    setErrors(({ [id]: _, ...rest }) => rest);
  };

  const drafts = (Object.entries(changes) as [string, Change][]).filter(([, c]) => "key" in c).map(([id]) => id);
  const allRevealed = drafts.length > 0 && drafts.every((id) => revealed.has(id));

  const parsed = useMemo(() => parseDotenv(importText, providers), [importText, providers]);

  const applyImport = () => {
    for (const [id, key] of parsed.found) change(id, { key });
    setImportText("");
    setImportOpen(false);
  };

  const onPaste = (e: ClipboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const text = e.clipboardData.getData("text");
    if (!/^\s*(export\s+)?[A-Za-z_]\w*\s*=/m.test(text)) return;
    e.preventDefault();
    setImportText(text);
    setImportOpen(true);
  };

  const discard = () => {
    setChanges({});
    setErrors({});
    setEditing(null);
  };

  // Each key is checked and saved on its own; the ones that fail stay as
  // unsaved edits, with why under them.
  const saveAll = async () => {
    setSaving("saving");
    setEditing(null);
    const results = await Promise.all(
      (Object.entries(changes) as [string, Change][]).map(async ([id, c]) =>
        [id, "remove" in c ? await onRemove(id) : await onSave(id, c.key)] as const
      )
    );
    const failed = results.filter(([, error]) => error);
    setChanges((cs) => Object.fromEntries(Object.entries(cs).filter(([id]) => failed.some(([f]) => f === id))));
    setErrors(Object.fromEntries(failed) as Record<string, string>);
    setRevealed(new Set());
    setSaving(failed.length ? "idle" : "saved");
  };

  const saved = keys?.filter((k) => k.hint).length ?? 0;
  const failedCount = Object.keys(errors).length;
  const showFooter = counts.total > 0 || saving !== "idle";

  // What the bar last said, so it doesn't change while it closes.
  const lastFooter = useRef<ReactNode>(null);
  if (showFooter) {
    lastFooter.current = (
      <>
        <p key={saving === "saved" ? "saved" : "dirty"} className="min-w-0 flex-1 truncate text-[11px] leading-4 motion-safe:animate-fade-in">
          {saving === "saved" ? (
            <span className="flex items-center gap-1.5 text-emerald-400">
              <CheckIcon size={13} /> Saved
            </span>
          ) : failedCount > 0 && saving === "idle" ? (
            <span className="text-red-400">
              {failedCount} {failedCount === 1 ? "key wasn't" : "keys weren't"} saved
            </span>
          ) : (
            <>
              <span className="font-medium text-white tabular-nums">
                {counts.total} unsaved {counts.total === 1 ? "change" : "changes"}
              </span>
              <span className="text-zinc-500 tabular-nums">
                {counts.added > 0 && ` · ${counts.added} added`}
                {counts.replaced > 0 && ` · ${counts.replaced} replaced`}
                {counts.removed > 0 && ` · ${counts.removed} removed`}
              </span>
            </>
          )}
        </p>
        {saving !== "saved" && (
          <>
            <ActionButton
              className="bg-transparent text-zinc-400 hover:bg-white/[0.07] hover:text-white"
              disabled={saving === "saving"}
              onClick={discard}
            >
              Discard
            </ActionButton>
            <ActionButton variant="primary" disabled={saving === "saving"} onClick={saveAll}>
              {saving === "saving" ? "Checking…" : "Save changes"}
            </ActionButton>
          </>
        )}
      </>
    );
  }
  const footer = lastFooter.current;

  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl bg-[#0c0c0c] ring-1 ring-white/[0.07]"
      onPaste={onPaste}
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[12px] leading-4 text-white">{title}</h2>
          <p className="truncate text-[11px] leading-4 text-zinc-500">
            {keys ? `${saved} of ${providers.length} saved` : "Loading…"} · paste a .env anywhere here
          </p>
        </div>
        {drafts.length > 0 && (
          <IconButton
            label={allRevealed ? "Hide unsaved keys" : "Reveal unsaved keys"}
            onClick={() => setRevealed(allRevealed ? new Set() : new Set(drafts))}
          >
            {allRevealed ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
          </IconButton>
        )}
        <ActionButton aria-expanded={importOpen} onClick={() => setImportOpen((o) => !o)}>
          <ClipboardTextIcon size={13} />
          Import .env
        </ActionButton>
      </div>

      <Collapse open={importOpen}>
        <div className="mx-3.5 mb-2.5 flex flex-col gap-2 rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/[0.06]">
          <textarea
            ref={importBox}
            aria-label="Paste .env contents"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={importPlaceholder}
            spellCheck={false}
            className="h-20 w-full resize-none rounded-md bg-black px-2.5 py-2 font-mono text-[11px] leading-[18px] text-white outline-hidden ring-1 ring-white/[0.07] placeholder:text-zinc-600 focus:ring-[#6B97FF]"
          />
          <div className="flex items-center gap-2">
            <span aria-live="polite" className="min-w-0 flex-1 truncate text-[11px] leading-4 text-zinc-500 tabular-nums">
              {parsed.found.size > 0 && (
                <span className="text-emerald-400">
                  {parsed.found.size} {parsed.found.size === 1 ? "key" : "keys"} found
                </span>
              )}
              {parsed.found.size > 0 && parsed.skipped > 0 && " · "}
              {parsed.skipped > 0 && `${parsed.skipped} other ${parsed.skipped === 1 ? "line" : "lines"} skipped`}
              {importText.trim() && parsed.found.size === 0 && parsed.skipped === 0 && "No keys found"}
            </span>
            <ActionButton className="bg-transparent text-zinc-400 hover:bg-white/[0.07] hover:text-white" onClick={() => setImportOpen(false)}>
              Cancel
            </ActionButton>
            <ActionButton variant="primary" disabled={parsed.found.size === 0} onClick={applyImport}>
              Add to table
            </ActionButton>
          </div>
        </div>
      </Collapse>

      <div role="table" aria-label="API keys" className="border-t border-white/[0.06]">
        <div role="row" className="grid grid-cols-[minmax(0,1fr)_176px_36px] bg-white/[0.02] text-[11px] leading-4 font-medium text-zinc-500">
          <div role="columnheader" className="px-3.5 py-1.5">Provider</div>
          <div role="columnheader" className="px-3 py-1.5">Key</div>
          <div role="columnheader"><span className="sr-only">Actions</span></div>
        </div>
        {providers.map((p) => (
          <KeyRow
            key={p.id}
            provider={p}
            usage={usage}
            hint={keys ? hint(p.id) : undefined}
            change={changes[p.id]}
            error={errors[p.id]}
            shown={revealed.has(p.id)}
            editing={editing === p.id}
            disabled={saving === "saving"}
            onEdit={(on) => setEditing(on ? p.id : null)}
            onChange={(c) => change(p.id, c)}
            onToggleShown={() =>
              setRevealed((s) => {
                const n = new Set(s);
                if (!n.delete(p.id)) n.add(p.id);
                return n;
              })
            }
          />
        ))}
      </div>

      <Collapse open={showFooter}>
        <div className="flex items-center gap-2 border-t border-white/[0.06] bg-white/[0.02] px-3.5 py-2">{footer}</div>
      </Collapse>
    </div>
  );
}

function KeyRow({
  provider,
  usage: showUsage,
  hint,
  change,
  error,
  shown,
  editing,
  disabled,
  onEdit,
  onChange,
  onToggleShown,
}: {
  provider: KeyProvider;
  usage: boolean;
  /** The saved key's last four characters; undefined while the keys load. */
  hint: string | null | undefined;
  change: Change | undefined;
  error: string | undefined;
  shown: boolean;
  editing: boolean;
  disabled: boolean;
  onEdit: (on: boolean) => void;
  onChange: (change: Change | null) => void;
  onToggleShown: () => void;
}) {
  const [draft, setDraft] = useState("");
  const usage = useUsage(provider.id as ProviderId, showUsage ? hint : null);
  const removed = change !== undefined && "remove" in change;
  const value = change !== undefined && "key" in change ? change.key : null;

  const startEdit = () => {
    setDraft(value ?? "");
    onEdit(true);
  };

  const commit = (keep: boolean) => {
    if (keep) onChange(draft.trim() ? { key: draft.trim() } : null);
    onEdit(false);
  };

  return (
    <div
      role="row"
      className={cn(
        "group/row grid grid-cols-[minmax(0,1fr)_176px_36px] border-t border-white/[0.06]",
        removed && "bg-red-500/[0.05]",
        value !== null && !hint && "bg-emerald-500/[0.05]"
      )}
    >
      <div role="rowheader" className="flex min-w-0 items-center gap-2.5 py-2 ps-3.5 pe-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-white">
          <img src={provider.logo} alt="" className="size-3.5 object-contain" draggable={false} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className={cn("truncate text-[12px] leading-4 text-white", removed && "text-zinc-500 line-through")}>
              {provider.name}
            </span>
            {value !== null && !hint && (
              <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-[10px] leading-4 font-medium text-emerald-400">
                new
              </span>
            )}
            {provider.free && (
              <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 text-[10px] leading-4 font-medium text-sky-300">
                free tier
              </span>
            )}
          </span>
          <span className="truncate text-[11px] leading-4 text-zinc-500">
            {hint && !showUsage ? (
              "Saved"
            ) : hint ? (
              usage === undefined ? (
                <span className="mt-0.5 block h-3 w-40 animate-pulse rounded-sm bg-white/[0.06]" role="status" aria-label="Loading usage" />
              ) : usage.value ? (
                <span className="text-zinc-300 tabular-nums">{describeUsage(usage.value)}</span>
              ) : (
                `Usage unavailable: ${usage.error}`
              )
            ) : (
              <button
                type="button"
                onClick={() => {
                  keepOpenFor();
                  invoke("open_url", { url: provider.keyUrl, browser: null }).catch(() => {});
                }}
                className="inline-flex items-center gap-0.5 text-zinc-300 hover:text-white"
              >
                Get a key
                <ArrowSquareOutIcon size={11} />
              </button>
            )}
          </span>
          {error && (
            <span role="alert" className="text-[11px] leading-4 text-red-400">
              {error}
            </span>
          )}
        </div>
        {value !== null && (
          <IconButton label={shown ? `Hide ${provider.name} key` : `Reveal ${provider.name} key`} onClick={onToggleShown}>
            {shown ? <EyeSlashIcon size={13} /> : <EyeIcon size={13} />}
          </IconButton>
        )}
      </div>

      <div role="cell" className={cn("relative flex min-w-0 items-center px-1.5 py-1.5", value !== null && hint && "bg-amber-400/10")}>
        {value !== null && hint && (
          <span aria-hidden className="absolute top-1/2 left-1 size-1 -translate-y-1/2 rounded-full bg-amber-400" />
        )}
        {hint === undefined ? (
          <div className="mx-1.5 h-4 w-24 animate-pulse rounded-sm bg-white/[0.06]" />
        ) : editing ? (
          <input
            type={shown ? "text" : "password"}
            aria-label={`${provider.name} API key`}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => commit(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(true);
              if (e.key === "Escape") commit(false);
            }}
            placeholder="Paste API key"
            autoComplete="off"
            spellCheck={false}
            className="h-7 w-full min-w-0 rounded-md bg-black px-1.5 font-mono text-[11px] text-white outline-hidden ring-1 ring-[#6B97FF] placeholder:font-sans placeholder:text-zinc-600"
          />
        ) : (
          <button
            type="button"
            aria-label={`Edit ${provider.name} key${value !== null ? " (changed)" : ""}`}
            title={value !== null && hint ? `Was: ••••${hint}` : undefined}
            disabled={disabled || removed}
            onClick={startEdit}
            className={cn(
              "flex h-7 w-full min-w-0 items-center rounded-md px-1.5 text-start font-mono text-[11px] outline-hidden transition-colors duration-150 hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-[#6B97FF] disabled:cursor-default disabled:hover:bg-transparent",
              removed && "text-zinc-500 line-through"
            )}
          >
            {value !== null ? (
              shown ? (
                <span className="truncate text-white">{value}</span>
              ) : (
                <span className="tracking-[0.12em] text-zinc-400">{MASK}</span>
              )
            ) : hint ? (
              <span className="text-zinc-400 tabular-nums" aria-label={`Key ending in ${hint}`}>
                ••••{hint}
              </span>
            ) : (
              <span className="font-sans text-zinc-600">Paste API key</span>
            )}
          </button>
        )}
      </div>

      <div role="cell" className="flex items-center justify-center">
        {removed ? (
          <IconButton label={`Keep ${provider.name} key`} onClick={() => onChange(null)} disabled={disabled}>
            <ArrowCounterClockwiseIcon size={13} />
          </IconButton>
        ) : (
          (hint || value !== null) && (
            <IconButton
              label={value !== null ? `Undo ${provider.name} edit` : `Remove ${provider.name} key`}
              onClick={() => onChange(value !== null ? null : { remove: true })}
              disabled={disabled}
              className="opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100"
            >
              {value !== null ? <ArrowCounterClockwiseIcon size={13} /> : <TrashIcon size={13} />}
            </IconButton>
          )
        )}
      </div>
    </div>
  );
}

/** Opens and closes to its content's height. Closed, it's out of the tab order. */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-zinc-400 outline-hidden transition-[color,background-color,opacity] duration-150 hover:bg-white/[0.07] hover:text-white focus-visible:ring-1 focus-visible:ring-[#6B97FF] disabled:pointer-events-none disabled:opacity-40",
        className
      )}
    >
      {children}
    </button>
  );
}
