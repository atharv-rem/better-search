import { invoke } from "@tauri-apps/api/core";

// Images from Rust (icons, thumbnails, favicons) arrive as the image file's
// raw bytes and are shown through blob: URLs. Bytes cross the IPC as binary,
// a third smaller than base64, and the image sits in the browser's blob store
// rather than as a long string on the JS heap. The search window lives for as
// long as the app, so each cache keeps only its newest entries and revokes
// the rest.

/** The type of an image from its first bytes. Browsers sniff raster formats,
 *  but only show an SVG with its type set. */
function imageType(bytes: Uint8Array) {
  const [a, b, c, d] = bytes;
  if (a === 0x89 && b === 0x50) return "image/png";
  if (a === 0xff && b === 0xd8) return "image/jpeg";
  if (a === 0x47 && b === 0x49) return "image/gif";
  if (a === 0x52 && b === 0x49 && c === 0x46 && d === 0x46) return "image/webp";
  if (a === 0 && b === 0 && c === 1 && d === 0) return "image/x-icon";
  if (new TextDecoder().decode(bytes.subarray(0, 256)).toLowerCase().includes("<svg")) return "image/svg+xml";
  return "";
}

/** A blob: URL for an image command's answer; null when it sent no bytes. */
export async function invokeImage(command: string, args: Record<string, unknown>) {
  const buffer = await invoke<ArrayBuffer>(command, args);
  if (!buffer.byteLength) return null;
  const bytes = new Uint8Array(buffer);
  return URL.createObjectURL(new Blob([bytes], { type: imageType(bytes) }));
}

/** Frees a blob: URL made by `invokeImage`; other URLs are left alone. */
export function revokeImage(url: string | null | undefined) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

/** Loads images with `command` by key, keeping the newest `limit`. Promises
 *  are cached, so callers asking for the same image share one load. */
export function imageCache(command: string, limit: number) {
  const cache = new Map<string, Promise<string | null>>();
  return (key: string, args: Record<string, unknown>) => {
    let image = cache.get(key);
    if (image) cache.delete(key); // re-inserted as the newest
    else image = invokeImage(command, args).catch(() => null);
    cache.set(key, image);
    if (cache.size > limit) {
      const [oldest, evicted] = cache.entries().next().value!;
      cache.delete(oldest);
      evicted.then(revokeImage);
    }
    return image;
  };
}
