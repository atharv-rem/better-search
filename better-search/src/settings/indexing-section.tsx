import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowsClockwiseIcon, DatabaseIcon, FolderIcon, FolderOpenIcon, HardDriveIcon, HardDrivesIcon, PlusIcon, StackIcon, XIcon } from "@phosphor-icons/react";
import { backend, BackendError, type IndexProgress, type IndexStatus } from "@/lib/backend";
import type { Settings } from "@/lib/settings";
import { ActionButton, Group, Row, Switch } from "@/settings/controls";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

/** A drive from `list_drives` in settings.rs. */
type Drive = { letter: string; label: string; ntfs: boolean; total_bytes: number; free_bytes: number };

/** From `storage_usage` in settings.rs. */
type StorageUsage = { index_bytes: number };

type RebuildState =
  | { kind: "idle"; message?: string }
  | { kind: "asking" } // UAC prompt is open
  | { kind: "indexing"; progress?: IndexProgress }
  | { kind: "error"; message: string };

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function timeAgo(unixSeconds: number) {
  const seconds = unixSeconds - Date.now() / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function gigabytes(bytes: number) {
  return `${Math.round(bytes / 1e9).toLocaleString()} GB`;
}

/** In 1024s, like Explorer shows file sizes. */
function fileSize(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: i < 2 ? 0 : 1 })} ${units[i]}`;
}

export function IndexingSection({ settings, save }: { settings: Settings; save: Save }) {
  const { indexing } = settings;
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [rebuild, setRebuild] = useState<RebuildState>({ kind: "idle" });
  const [drives, setDrives] = useState<Drive[] | null>(null);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  // The exclusions the current index was built with, as far as this window
  // knows: changing them only shows once the index is rebuilt.
  const builtWith = useRef(JSON.stringify(indexing));
  const changed = JSON.stringify(indexing) !== builtWith.current;
  const latestIndexing = useRef(indexing);
  latestIndexing.current = indexing;

  const refreshStatus = useCallback(() => {
    invoke<StorageUsage>("storage_usage")
      .then(setStorage)
      .catch(() => {});
    return backend.status().then((s) => {
      setStatus(s);
      if (s.indexing) setRebuild((r) => (r.kind === "indexing" ? r : { kind: "indexing" }));
    });
  }, []);

  useEffect(() => {
    // The backend is started with the window; give it a moment if it's not up yet.
    refreshStatus().catch(() => setTimeout(() => refreshStatus().catch(() => {}), 800));
    invoke<Drive[]>("list_drives")
      .then(setDrives)
      .catch(() => setDrives([]));
  }, [refreshStatus]);

  useEffect(
    () =>
      backend.onEvent((e) => {
        if (e.type === "index_progress") setRebuild({ kind: "indexing", progress: e.progress });
        else if (e.type === "index_done") {
          setRebuild({ kind: "idle" });
          builtWith.current = JSON.stringify(latestIndexing.current);
          refreshStatus().catch(() => {});
        } else setRebuild({ kind: "error", message: e.error });
      }),
    [refreshStatus]
  );

  const startRebuild = async () => {
    setRebuild({ kind: "asking" });
    try {
      await backend.reindex();
      setRebuild((r) => (r.kind === "asking" ? { kind: "indexing" } : r));
    } catch (err) {
      if (err instanceof BackendError && err.code === "admin_denied") {
        setRebuild({ kind: "idle", message: "Windows permission was declined, so the index wasn't rebuilt." });
      } else if (err instanceof BackendError && err.code === "busy") {
        setRebuild({ kind: "indexing" });
      } else {
        setRebuild({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const setIndexing = (change: Partial<Settings["indexing"]>) =>
    save((s) => ({ ...s, indexing: { ...s.indexing, ...change } }));

  const busy = rebuild.kind === "asking" || rebuild.kind === "indexing";
  const included = (drives ?? []).filter((d) => d.ntfs && !indexing.excluded_drives.includes(d.letter));

  return (
    <>
      <Group footer="Rebuilding asks Windows for administrator permission, to read each drive's file list directly.">
        <Row
          icon={<DatabaseIcon size={18} />}
          label={
            status === null
              ? "Reading the index…"
              : status.indexed_at === 0
                ? "Not indexed yet"
                : `${status.file_count.toLocaleString()} files and folders`
          }
          description={
            rebuild.kind === "indexing" ? (
              <IndexingProgress progress={rebuild.progress} />
            ) : rebuild.kind === "asking" ? (
              "Waiting for permission…"
            ) : changed ? (
              <span className="text-amber-300/90">Rebuild the index to apply your changes.</span>
            ) : status && status.indexed_at > 0 ? (
              `Last indexed ${timeAgo(status.indexed_at)}`
            ) : undefined
          }
          error={rebuild.kind === "error" ? `Indexing failed: ${rebuild.message}` : rebuild.kind === "idle" ? rebuild.message : null}
        >
          <ActionButton variant={changed ? "primary" : "secondary"} disabled={busy} onClick={startRebuild}>
            <ArrowsClockwiseIcon size={14} className={busy ? "motion-safe:animate-spin" : undefined} />
            {busy ? "Indexing…" : "Rebuild index"}
          </ActionButton>
        </Row>
      </Group>

      <Group title="Storage">
        <Row icon={<HardDrivesIcon size={18} />} label="Index database" description="The local SQLite file your files are searched in">
          <StorageSize bytes={storage?.index_bytes} />
        </Row>
        <Row
          icon={<StackIcon size={18} />}
          label="Database cache"
          description={
            status
              ? `Recently read parts of the index, kept in memory for faster searches. Up to ${fileSize(status.cache_limit)} per connection.`
              : "Recently read parts of the index, kept in memory for faster searches"
          }
        >
          <StorageSize bytes={status?.cache_bytes} />
        </Row>
      </Group>

      <Group title="Drives" footer="Only NTFS drives can be indexed.">
        {drives === null ? (
          <Row label="Finding drives…" />
        ) : drives.length === 0 ? (
          <Row label="No drives found" />
        ) : (
          drives.map((d) => {
            const on = d.ntfs && !indexing.excluded_drives.includes(d.letter);
            return (
              <Row
                key={d.letter}
                icon={<HardDriveIcon size={18} />}
                label={`${d.label || "Local Disk"} (${d.letter})`}
                description={
                  d.ntfs
                    ? `${gigabytes(d.free_bytes)} free of ${gigabytes(d.total_bytes)}`
                    : "Not NTFS, so it can't be indexed"
                }
              >
                <Switch
                  checked={on}
                  // At least one drive stays: there'd be nothing to search.
                  disabled={!d.ntfs || (on && included.length === 1)}
                  label={`Index ${d.letter}`}
                  onChange={(index) =>
                    setIndexing({
                      excluded_drives: index
                        ? indexing.excluded_drives.filter((x) => x !== d.letter)
                        : [...indexing.excluded_drives, d.letter],
                    })
                  }
                />
              </Row>
            );
          })
        )}
      </Group>

      <ExcludedFolders
        folders={indexing.excluded_folders}
        onChange={(excluded_folders) => setIndexing({ excluded_folders })}
      />
    </>
  );
}

function StorageSize({ bytes }: { bytes?: number }) {
  return <span className="text-[13px] leading-4 text-zinc-400 tabular-nums">{bytes === undefined ? "…" : fileSize(bytes)}</span>;
}

function IndexingProgress({ progress: p }: { progress?: IndexProgress }) {
  const pct = p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
  return (
    <span className="flex items-center gap-2">
      <span>
        {p ? `${p.phase === "reading" ? "Reading" : "Saving"} ${p.drive}` : "Indexing your drives"}
        {pct !== null && ` · ${pct}%`}
      </span>
      <span className="h-1 w-24 overflow-hidden rounded-full bg-white/10">
        <span
          className="block h-full rounded-full bg-white transition-[width] duration-300"
          style={{ width: pct === null ? "10%" : `${pct}%` }}
        />
      </span>
    </span>
  );
}

function ExcludedFolders({ folders, onChange }: { folders: string[]; onChange: (folders: string[]) => Promise<string | null> }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async (folder: string) => {
    const f = folder.trim();
    if (!f) return;
    if (folders.some((x) => x.toLowerCase() === f.toLowerCase())) {
      setError(`${f} is already excluded.`);
      return;
    }
    const err = await onChange([...folders, f]);
    setError(err);
    if (!err) setDraft("");
  };

  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: "Choose a folder not to index" }).catch(
      () => null
    );
    if (typeof picked === "string") add(picked);
  };

  return (
    <Group
      title="Excluded folders"
      footer="A full path skips that folder. A name, like build, skips every folder with that name. Caches, build output and system folders are always skipped."
    >
      {folders.map((f) => (
        <Row key={f} icon={<FolderIcon size={18} />} label={f} description={/[\\/]/.test(f) ? undefined : "Every folder with this name"}>
          <ActionButton aria-label={`Stop excluding ${f}`} title="Remove" onClick={() => onChange(folders.filter((x) => x !== f))}>
            <XIcon size={14} />
          </ActionButton>
        </Row>
      ))}
      <Row
        label={
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && add(draft)}
            placeholder="D:\Archive or a folder name"
            aria-label="Folder to exclude"
            spellCheck={false}
            className="h-7 w-full rounded-md bg-white/[0.07] px-2.5 text-[12px] leading-4 text-white outline-hidden placeholder:text-zinc-500 focus:ring-1 focus:ring-[#6B97FF] focus:ring-inset"
          />
        }
        error={error}
      >
        <ActionButton onClick={browse}>
          <FolderOpenIcon size={14} />
          Browse
        </ActionButton>
        <ActionButton variant="primary" disabled={!draft.trim()} onClick={() => add(draft)}>
          <PlusIcon size={14} />
          Add
        </ActionButton>
      </Row>
    </Group>
  );
}
