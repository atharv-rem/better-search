import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowSquareOutIcon, GlobeIcon } from "@/lib/phosphor";
import type { Settings } from "@/lib/settings";
import { describeUsage, PROVIDERS, useApiKeys, useUsage, type KeyStatus, type Provider } from "@/lib/web-search";
import { ActionButton, Group, Row, Select } from "@/settings/controls";
import { Shortcut } from "@/components/ui/kbd";
import { keepOpenFor } from "@/settings/keep-open";

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
        footer={
          withKey.length === 0
            ? "Add a key below to see web results right here instead of in your browser."
            : (
              <>
                <Shortcut keys={["Enter"]} /> on a result opens it in your browser. <Shortcut keys={["Ctrl", "Enter"]} /> searches in the browser instead.
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
              ...withKey.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={chooseProvider}
          />
        </Row>
      </Group>
      <Group
        title="Your API keys"
        footer="Keys are kept in Windows Credential Manager and only sent to their own provider. Saving a key runs one small search to check it."
      >
        {PROVIDERS.map((p) => (
          <KeyRow
            key={p.id}
            provider={p}
            status={keys?.find((k) => k.provider === p.id)}
            onSave={(key) => saveKey(p.id, key)}
            onRemove={() => remove(p.id)}
          />
        ))}
      </Group>
    </>
  );
}

function KeyRow({
  provider,
  status,
  onSave,
  onRemove,
}: {
  provider: Provider;
  /** Undefined while the keys load. */
  status: KeyStatus | undefined;
  onSave: (key: string) => Promise<string | null>;
  onRemove: () => Promise<string | null>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usage = useUsage(provider.id, status?.hint);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const message = await action();
    setBusy(false);
    setError(message);
    if (!message) setDraft("");
  };

  return (
    <Row
      label={provider.name}
      description={
        <>
          {provider.description}{" "}
          {!status?.hint && (
            <button
              type="button"
              onClick={() => {
                keepOpenFor();
                invoke("open_url", {
                  url: provider.keyUrl,
                  browser: null,
                }).catch(() => {});
              }}
              className="inline-flex items-center gap-0.5 text-zinc-300 hover:text-white"
            >
              Get a key
              <ArrowSquareOutIcon size={11} />
            </button>
          )}
          {status?.hint &&
            (usage === undefined ? (
              <span
                className="mt-1 block h-3 w-48 animate-pulse rounded-sm bg-white/[0.06]"
                role="status"
                aria-label="Loading usage"
              />
            ) : usage.value ? (
              <span className="mt-0.5 block text-zinc-300 tabular-nums">{describeUsage(usage.value)}</span>
            ) : (
              <span className="mt-0.5 block">Usage unavailable: {usage.error}</span>
            ))}
        </>
      }
      error={error}
    >
      {status === undefined ? (
        <div className="h-7 w-24 animate-pulse rounded-md bg-white/[0.04]" />
      ) : status.hint ? (
        <>
          <span
            className="text-[11px] leading-4 text-zinc-400 tabular-nums"
            aria-label={`Key ending in ${status.hint}`}
          >
            ••••{status.hint}
          </span>
          <ActionButton variant="danger" disabled={busy} onClick={() => run(onRemove)}>
            Remove
          </ActionButton>
        </>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) run(() => onSave(draft));
          }}
        >
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste API key"
            aria-label={`${provider.name} API key`}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className="h-7 w-44 rounded-md bg-white/[0.07] px-2.5 text-[11px] leading-4 text-white outline-hidden placeholder:text-zinc-500 focus:ring-1 focus:ring-[#6B97FF] disabled:opacity-50"
          />
          <ActionButton type="submit" variant="primary" disabled={busy || !draft.trim()}>
            {busy ? "Checking…" : "Save"}
          </ActionButton>
        </form>
      )}
    </Row>
  );
}
