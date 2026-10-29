import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Client for the Go sidecar. Each request goes out as a JSON line through the
// `backend_request` command, which resolves with the reply to it. Events,
// which answer no request (indexing progress), come as `backend-message`.

export interface SearchResult {
  id: number;
  name: string;
  path: string;
  /** "app": a Start menu app listed with the files (App.tsx), not from the
   *  index; `path` is its "shell:AppsFolder\…" address. */
  type: "file" | "directory" | "app";
  size: number;
  modified_at: number;
  open_count: number;
  /** An app's id in the Apps folder (snap.rs `InstalledApp`). */
  app_id?: string;
}

export interface IndexStatus {
  indexing: boolean;
  indexed_at: number;
  file_count: number;
  /** SQLite page cache in the backend's memory, across its connections. */
  cache_bytes: number;
  /** The most each connection's page cache may hold. */
  cache_limit: number;
}

export interface IndexProgress {
  drive: string;
  phase: "reading" | "saving";
  done: number;
  total: number;
}

export interface DriveStats {
  drive: string;
  records: number;
  files: number;
  duration_ms: number;
}

interface Message {
  id?: string;
  type: string;
  status: "ok" | "error";
  results?: unknown;
  data?: unknown;
  error?: string;
  code?: string;
}

export type BackendEvent =
  | { type: "index_progress"; progress: IndexProgress }
  | { type: "index_done"; stats: DriveStats[] }
  | { type: "index_error"; error: string; code?: string };

export class BackendError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const eventListeners = new Set<(e: BackendEvent) => void>();
let nextId = 1;
// Rust matches replies to requests by id across every window, so ids must
// not clash between windows.
const idPrefix = Math.random().toString(36).slice(2, 8);

listen<string>("backend-message", ({ payload }) => {
  let msg: Message;
  try {
    msg = JSON.parse(payload);
  } catch {
    console.warn("backend: not JSON:", payload);
    return;
  }

  let event: BackendEvent | null = null;
  if (msg.type === "index_progress") event = { type: msg.type, progress: msg.data as IndexProgress };
  else if (msg.type === "index_done") event = { type: msg.type, stats: (msg.data as DriveStats[]) ?? [] };
  else if (msg.type === "index_error") event = { type: msg.type, error: msg.error ?? "indexing failed", code: msg.code };
  if (event) eventListeners.forEach((fn) => fn(event));
});

/** Rejects if the sidecar isn't running or stops before answering, or with
 *  its error. A search rejects with code "superseded" once a newer one starts. */
async function request(type: string, fields: Record<string, unknown> = {}): Promise<Message> {
  const id = `${idPrefix}-${nextId++}`;
  let msg: Message;
  try {
    msg = await invoke<Message>("backend_request", { id, message: JSON.stringify({ id, type, ...fields }) });
  } catch (e) {
    throw new BackendError(String(e));
  }
  if (msg.status !== "ok") throw new BackendError(msg.error ?? "backend error", msg.code);
  return msg;
}

export const backend = {
  async search(query: string, limit = 50): Promise<SearchResult[]> {
    const msg = await request("search", { query, limit });
    return (msg.results as SearchResult[]) ?? [];
  },

  /** Files containing every word of `query`, from Windows Search, its best
   *  matches first, with images whose text has them when `withImages` (image
   *  indexing is on). Rejects with code "no_windows_search" when it's off. */
  async searchContent(query: string, limit = 50, withImages = false): Promise<SearchResult[]> {
    const msg = await request("content", { query, limit, with_images: withImages });
    return (msg.results as SearchResult[]) ?? [];
  },

  async status(): Promise<IndexStatus> {
    return (await request("status")).data as IndexStatus;
  },

  /** Records the open for ranking. */
  async markOpened(fileId: number): Promise<void> {
    await request("open", { file_id: fileId });
  },

  /** Starts a full index. Windows shows the UAC prompt; resolves once the
   *  user has accepted, rejects with code "admin_denied" if they decline, or
   *  "disk_full" (before asking) if the index's drive is short of space. */
  async reindex(): Promise<void> {
    await request("reindex");
  },

  onEvent(fn: (e: BackendEvent) => void): () => void {
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
  },
};
