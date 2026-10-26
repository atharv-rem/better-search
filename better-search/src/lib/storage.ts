import { invoke } from "@tauri-apps/api/core";

// Where the search index lives (storage.rs): on the Windows drive unless the
// user moved it to another one with more space.

/** From `index_location` in storage.rs. */
export interface IndexLocation {
  folder: string;
  /** "C:" */
  drive: string;
  /** The drive the index is on when it hasn't been moved. */
  default_drive: string;
  index_bytes: number;
  /** Free space a full index wants on its drive. */
  needed_bytes: number;
  free_bytes: number;
}

/** A drive from `list_drives` in settings.rs. */
export interface Drive {
  letter: string;
  label: string;
  ntfs: boolean;
  total_bytes: number;
  free_bytes: number;
}

export const indexLocation = () => invoke<IndexLocation>("index_location");

/** Moves the index files to `drive` and restarts the backend on them. Rejects
 *  with a message to show. */
export function moveIndex(drive: string): Promise<IndexLocation> {
  return invoke<IndexLocation>("move_index", { drive }).catch((err) => {
    throw new Error(String(err));
  });
}

/** The drives with room for the index, most free space first. */
export function roomyDrives(location: IndexLocation, drives: Drive[]) {
  return drives.filter((d) => d.free_bytes >= location.needed_bytes).sort((a, b) => b.free_bytes - a.free_bytes);
}

/** "300 MB", "12 GB" */
export function diskSize(bytes: number) {
  const mb = bytes / 2 ** 20;
  return mb >= 1024 ? `${Math.round(mb / 1024).toLocaleString()} GB` : `${Math.ceil(mb).toLocaleString()} MB`;
}
