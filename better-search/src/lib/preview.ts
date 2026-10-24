import { invoke } from "@tauri-apps/api/core";
import type { SearchResult } from "@/lib/backend";
import { extensionOf, groupOf } from "@/lib/file-groups";
import { invokeImage, revokeImage } from "@/lib/image-cache";

export interface FolderEntry {
  name: string;
  dir: boolean;
}

/** What the preview above the search bar shows for a result. */
export type Preview =
  | { kind: "image"; url: string }
  | { kind: "text"; text: string }
  | { kind: "folder"; entries: FolderEntry[]; total: number; more: boolean }
  /** A document's opening paragraphs, drawn as a page (docx.rs). */
  | { kind: "page"; paragraphs: { text: string; heading: boolean }[] }
  | { kind: "none" }; // just the file's icon and details

// Read as text before asking Windows for a thumbnail: their thumbnails, if
// any, are a tiny page with unreadable text. Code files are read as text too.
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv", "tsv", "log", "ini", "cfg", "conf", "env", "properties", "gitignore", "editorconfig", "srt",
]);

// Word documents, read for their text when Windows has no thumbnail of them
// (no Office installed).
const DOCX_EXTENSIONS = new Set(["docx", "docm", "dotx", "dotm"]);

async function loadUncached(result: SearchResult, thumbSize: number): Promise<Preview> {
  if (result.type === "directory") {
    const folder = await invoke<Omit<Extract<Preview, { kind: "folder" }>, "kind"> | null>("folder_preview", {
      path: result.path,
    });
    return folder ? { kind: "folder", ...folder } : { kind: "none" };
  }

  const group = groupOf(result);
  const text = () => invoke<string | null>("text_preview", { path: result.path });
  if (group === "code" || TEXT_EXTENSIONS.has(extensionOf(result.name))) {
    const t = await text();
    if (t !== null) return { kind: "text", text: t };
  }
  // Images, videos, PDFs, Office files and anything else Windows can draw.
  const url = await invokeImage("file_thumbnail", { path: result.path, size: thumbSize });
  if (url) return { kind: "image", url };
  if (DOCX_EXTENSIONS.has(extensionOf(result.name))) {
    const doc = await invoke<Extract<Preview, { kind: "image" | "page" }> | null>("docx_preview", { path: result.path });
    if (doc) return doc;
  }
  // An unknown type may still be plain text (README, LICENSE, .nfo).
  if (group === "other") {
    const t = await text();
    if (t !== null) return { kind: "text", text: t };
  }
  return { kind: "none" };
}

// Recent previews, so moving back up the list is instant. Thumbnails are a few
// hundred KB each, so only a handful are kept, and a dropped one is freed.
const CACHE_SIZE = 16;
const cache = new Map<string, Promise<Preview>>();

export function cachedPreview(result: SearchResult, thumbSize: number) {
  return cache.get(`${thumbSize}|${result.path}`);
}

export function loadPreview(result: SearchResult, thumbSize: number) {
  const key = `${thumbSize}|${result.path}`;
  let preview = cache.get(key);
  if (preview) {
    cache.delete(key); // re-insert as the newest
  } else {
    preview = loadUncached(result, thumbSize).catch((): Preview => ({ kind: "none" }));
  }
  cache.set(key, preview);
  if (cache.size > CACHE_SIZE) {
    const [oldest, evicted] = cache.entries().next().value!;
    cache.delete(oldest);
    evicted.then((p) => p.kind === "image" && revokeImage(p.url));
  }
  return preview;
}
