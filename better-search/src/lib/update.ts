import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/// The newer version Rust's daily check found, or null. Asks again whenever
/// `refresh` changes: a suspended search window misses the event.
export function usePendingUpdate(refresh?: unknown) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const unlisten = listen<string | null>("update-available", (e) => setVersion(e.payload));
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    invoke<string | null>("pending_update")
      .then(setVersion)
      .catch(() => {});
  }, [refresh]);
  return version;
}
