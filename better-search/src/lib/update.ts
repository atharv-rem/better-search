import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/// The newer version Rust's daily check found, or null. `known` is a reading
/// the caller already has, kept until the next one: the search window gets
/// one with every show, as a suspended window misses the event. Without it,
/// asks once.
export function usePendingUpdate(known?: string | null) {
  const [version, setVersion] = useState<string | null>(known ?? null);
  useEffect(() => {
    const unlisten = listen<string | null>("update-available", (e) => setVersion(e.payload));
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (known !== undefined) {
      setVersion(known);
      return;
    }
    invoke<string | null>("pending_update")
      .then(setVersion)
      .catch(() => {});
  }, [known]);
  return version;
}
