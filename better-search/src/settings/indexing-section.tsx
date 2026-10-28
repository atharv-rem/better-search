import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowsClockwiseIcon, FolderIcon, FolderOpenIcon, HardDriveIcon, PlusIcon, XIcon } from "@/lib/phosphor";
import { backend, BackendError, type IndexProgress, type IndexStatus } from "@/lib/backend";
import type { Settings } from "@/lib/settings";
import { diskSize, indexLocation, moveIndex, type Drive, type IndexLocation } from "@/lib/storage";
import { ActionButton, Group, Row, Select, Switch } from "@/settings/controls";
import { keepOpenWhile } from "@/settings/keep-open";
import { ServerRack, type RackUnit } from "@/settings/server-rack";

type Save = (change: (s: Settings) => Settings) => Promise<string | null>;

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

/** In 1024s, like Explorer and the index location's "free on" line. */
function gigabytes(bytes: number) {
  return `${Math.round(bytes / 2 ** 30).toLocaleString()} GB`;
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
  const [location, setLocation] = useState<IndexLocation | null>(null);
  // The exclusions the current index was built with, as far as this window
  // knows: changing them only shows once the index is rebuilt.
  const builtWith = useRef(JSON.stringify(indexing));
  const changed = JSON.stringify(indexing) !== builtWith.current;
  const latestIndexing = useRef(indexing);
  latestIndexing.current = indexing;

  const refreshStatus = useCallback(() => {
    indexLocation()
      .then(setLocation)
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
        } else setRebuild({ kind: "error", message: e.code === "disk_full" ? DISK_FULL : e.error });
      }),
    [refreshStatus]
  );

  const startRebuild = async () => {
    setRebuild({ kind: "asking" });
    try {
      await keepOpenWhile(backend.reindex());
      setRebuild((r) => (r.kind === "asking" ? { kind: "indexing" } : r));
    } catch (err) {
      if (err instanceof BackendError && err.code === "admin_denied") {
        setRebuild({ kind: "idle", message: "Windows permission was declined, so the index wasn't rebuilt." });
      } else if (err instanceof BackendError && err.code === "busy") {
        setRebuild({ kind: "indexing" });
      } else if (err instanceof BackendError && err.code === "disk_full") {
        setRebuild({ kind: "error", message: DISK_FULL });
      } else {
        setRebuild({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const setIndexing = (change: Partial<Settings["indexing"]>) =>
    save((s) => ({ ...s, indexing: { ...s.indexing, ...change } }));

  const busy = rebuild.kind === "asking" || rebuild.kind === "indexing";
  const included = (drives ?? []).filter((d) => d.ntfs && !indexing.excluded_drives.includes(d.letter));

  const reading = rebuild.kind === "indexing" ? rebuild.progress : undefined;
  const pct = reading && reading.total > 0 ? Math.min(100, Math.round((reading.done / reading.total) * 100)) : null;

  const controller: RackUnit = {
    lit: true,
    lamp: busy ? "busy" : status && status.indexed_at > 0 ? "on" : "off",
    title:
      status === null ? "Reading the index…" : status.indexed_at === 0 ? "Not indexed yet" : `${status.file_count.toLocaleString()} items`,
    detail: reading
      ? `${reading.phase === "reading" ? "Reading" : "Saving"} ${reading.drive}`
      : rebuild.kind === "asking"
        ? "Waiting for permission…"
        : changed
          ? "Rebuild to apply your changes"
          : status && status.indexed_at > 0
            ? `Last indexed ${timeAgo(status.indexed_at)}`
            : undefined,
    warn: changed && !busy,
    fraction: pct === null ? undefined : pct / 100,
  };

  const driveUnits: RackUnit[] = (drives ?? []).map((d) => {
    const on = d.ntfs && !indexing.excluded_drives.includes(d.letter);
    const reads = reading?.drive.toUpperCase().startsWith(d.letter.toUpperCase());
    return {
      lamp: !on ? "off" : reads ? "busy" : "on",
      title: `${d.letter} ${d.label || "Local Disk"}`,
      // Only what the drive's state changes: space while it's indexed, why not otherwise.
      detail: !d.ntfs ? "Not NTFS" : !on ? "Excluded" : `${gigabytes(d.free_bytes)} free of ${gigabytes(d.total_bytes)}`,
      fraction: d.total_bytes > 0 ? 1 - d.free_bytes / d.total_bytes : 0,
    };
  });
  const top = [controller, ...driveUnits];

  const bottom: RackUnit[] = [
    {
      lamp: "none",
      title: "Index database",
      detail: location ? `${fileSize(location.index_bytes)} on ${location.drive}` : "…",
    },
    {
      lamp: "none",
      title: "Database cache",
      detail: status ? `${fileSize(status.cache_bytes)} of ${fileSize(status.cache_limit)}` : "…",
      fraction: status && status.cache_limit > 0 ? Math.min(1, status.cache_bytes / status.cache_limit) : 0,
    },
  ];

  return (
    <>
      <ServerRack top={top} bottom={bottom} indexing={rebuild.kind === "indexing"} />

      <Group footer="Rebuilding asks Windows for administrator permission, to read each drive's file list directly.">
        <Row
          icon={<ArrowsClockwiseIcon size={18} className={busy ? "motion-safe:animate-spin" : undefined} />}
          label="Rebuild index"
          description={
            rebuild.kind === "asking" ? (
              "Waiting for permission…"
            ) : changed && !busy ? (
              // Search leaves out what's excluded straight away (helper's
              // exclusions); what's included again needs reading in.
              <span className="text-amber-300/90">
                Rebuild the index to apply your changes. What you excluded is already left out of results.
              </span>
            ) : undefined
          }
          error={rebuild.kind === "error" ? `Indexing failed: ${rebuild.message}` : rebuild.kind === "idle" ? rebuild.message : null}
        >
          <ActionButton variant={changed ? "primary" : "secondary"} disabled={busy} onClick={startRebuild}>
            {busy ? "Indexing…" : "Rebuild index"}
          </ActionButton>
        </Row>
      </Group>

      <IndexDrive location={location} drives={drives} busy={busy} onMoved={setLocation} />

      <Group title="Drives to index" footer="Only NTFS drives can be indexed.">
        {drives === null ? (
          <Row label="Finding drives…" />
        ) : drives.length === 0 ? (
          <Row label="No drives found" />
        ) : (
          drives.map((d) => {
            const on = d.ntfs && !indexing.excluded_drives.includes(d.letter);
            return (
              <Row key={d.letter} icon={<HardDriveIcon size={18} />} label={`${d.label || "Local Disk"} (${d.letter})`}>
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

const DISK_FULL = "There isn't enough free space on the index's drive. Free some up, or keep the index on another drive.";

/** Which drive the index file is kept on. It covers every drive either way. */
function IndexDrive({
  location,
  drives,
  busy,
  onMoved,
}: {
  location: IndexLocation | null;
  drives: Drive[] | null;
  busy: boolean;
  onMoved: (location: IndexLocation) => void;
}) {
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async (drive: string) => {
    if (!location || drive === location.drive) return;
    setMoving(true);
    setError(null);
    try {
      onMoved(await moveIndex(drive));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoving(false);
    }
  };

  const short = location !== null && location.free_bytes < location.needed_bytes;
  return (
    <Group
      title="Index location"
      footer="Where the index file is kept. Move it to a drive with more free space if this one is filling up; it still searches every drive."
    >
      <Row
        icon={<HardDriveIcon size={18} />}
        label={location ? location.folder : "…"}
        description={
          location &&
          (short ? (
            <span className="text-amber-300/90">
              {location.drive} has {diskSize(location.free_bytes)} free. Rebuilding needs about {diskSize(location.needed_bytes)}.
            </span>
          ) : (
            `${diskSize(location.free_bytes)} free on ${location.drive}`
          ))
        }
        error={error}
      >
        {location && drives && !busy && !moving ? (
          <Select
            label="Drive for the index"
            value={location.drive}
            options={drives.map((d) => ({
              value: d.letter,
              label: `${d.letter}${d.letter === location.default_drive ? " (default)" : ""} · ${diskSize(d.free_bytes)} free`,
            }))}
            onChange={move}
          />
        ) : (
          <ActionButton disabled>{moving ? "Moving…" : (location?.drive ?? "…")}</ActionButton>
        )}
      </Row>
    </Group>
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
    const picked = await keepOpenWhile(
      openDialog({ directory: true, multiple: false, title: "Choose a folder not to index" }).catch(() => null)
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
            className="h-7 w-full rounded-md bg-white/[0.07] px-2.5 text-[11px] leading-4 text-white outline-hidden placeholder:text-zinc-500 focus:ring-1 focus:ring-[#6B97FF] focus:ring-inset"
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
