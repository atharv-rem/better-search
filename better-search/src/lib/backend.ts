import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Client for the Go sidecar. Requests go out as JSON lines via the
// `backend_send` command; every stdout line comes back as a
// `backend-message` event. Replies carry the request's id, events don't.

export interface SearchResult {
  id: number;
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modified_at: number;
  open_count: number;
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

const pending = new Map<string, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
const eventListeners = new Set<(e: BackendEvent) => void>();
let nextId = 1;
// Every window gets every reply, so ids must not clash between windows.
const idPrefix = Math.random().toString(36).slice(2, 8);

listen<string>("backend-message", ({ payload }) => {
  let msg: Message;
  try {
    msg = JSON.parse(payload);
  } catch {
    console.warn("backend: not JSON:", payload);
    return;
  }

  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.status === "ok") p.resolve(msg);
    else p.reject(new BackendError(msg.error ?? "backend error", msg.code));
    return;
  }

  let event: BackendEvent | null = null;
  if (msg.type === "index_progress") event = { type: msg.type, progress: msg.data as IndexProgress };
  else if (msg.type === "index_done") event = { type: msg.type, stats: (msg.data as DriveStats[]) ?? [] };
  else if (msg.type === "index_error") event = { type: msg.type, error: msg.error ?? "indexing failed", code: msg.code };
  if (event) eventListeners.forEach((fn) => fn(event));
});

// The sidecar exited (it crashed, or the app is quitting): nothing in flight
// will be answered.
listen("backend-stopped", () => {
  for (const p of pending.values()) p.reject(new BackendError("backend stopped"));
  pending.clear();
});

async function request(type: string, fields: Record<string, unknown> = {}): Promise<Message> {
  const id = `${idPrefix}-${nextId++}`;
  const reply = new Promise<Message>((resolve, reject) => pending.set(id, { resolve, reject }));
  try {
    await invoke("backend_send", { message: JSON.stringify({ id, type, ...fields }) });
  } catch (e) {
    pending.delete(id);
    throw new BackendError(String(e));
  }
  return reply;
}

export const backend = {
  async search(query: string, limit = 50): Promise<SearchResult[]> {
    const msg = await request("search", { query, limit });
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
