import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Reading the text in images with Windows' OCR (images.rs), so content search
// finds screenshots by their words. The text is kept in images.db, apart from
// the search index, so deleting it frees its space without touching the index.

/** Matches `Progress` in images.rs. */
export interface ImageProgress {
  running: boolean;
  done: number;
  total: number;
  error: string | null;
}

/** Matches `Status` in images.rs. */
export interface ImageIndexStatus {
  enabled: boolean;
  /** The folders read: the user's own, or the default ones. */
  folders: string[];
  default_folders: boolean;
  progress: ImageProgress;
  /** images.db (Stats in images.go). */
  stored: { exists: boolean; images: number; with_text: number; bytes: number };
}

export function imageIndexStatus() {
  return invoke<ImageIndexStatus>("image_index_status");
}

/** Turns image indexing off and deletes what it stored. */
export function deleteImageIndex() {
  return invoke<void>("delete_image_index");
}

/** The status, kept current while images are being read. */
export function useImageIndex(): [ImageIndexStatus | null, () => void] {
  const [status, setStatus] = useState<ImageIndexStatus | null>(null);
  const refresh = () => {
    imageIndexStatus()
      .then(setStatus)
      .catch(() => {});
  };
  useEffect(() => {
    refresh();
    let lastRefresh = 0;
    const unlisten = listen<ImageProgress>("image-index-progress", ({ payload }) => {
      setStatus((s) => (s ? { ...s, progress: payload } : s));
      // The stored count and size, now and then while reading, and at the end.
      const now = Date.now();
      if (!payload.running || now - lastRefresh > 3000) {
        lastRefresh = now;
        refresh();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
  return [status, refresh];
}
