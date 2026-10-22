import type { SearchResult } from "@/lib/backend";

export type FileGroup = "folders" | "documents" | "images" | "videos" | "audio" | "code" | "archives" | "apps" | "other";

// Display order of the pills.
const GROUPS: { id: FileGroup; label: string }[] = [
  { id: "folders", label: "Folders" },
  { id: "documents", label: "Documents" },
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "audio", label: "Audio" },
  { id: "code", label: "Code" },
  { id: "archives", label: "Archives" },
  { id: "apps", label: "Apps" },
  { id: "other", label: "Other" },
];

const EXTENSIONS: Record<Exclude<FileGroup, "folders" | "other">, string[]> = {
  documents: ["pdf", "doc", "docx", "txt", "rtf", "odt", "md", "xls", "xlsx", "csv", "ppt", "pptx", "epub"],
  images: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff", "heic", "psd"],
  videos: ["mp4", "mkv", "mov", "avi", "wmv", "webm", "flv", "m4v"],
  audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"],
  code: [
    "js", "jsx", "ts", "tsx", "py", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs", "php", "rb",
    "html", "css", "scss", "json", "xml", "yml", "yaml", "toml", "sql", "sh", "ps1", "bat",
  ],
  archives: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"],
  apps: ["exe", "msi", "lnk", "appx"],
};

const GROUP_BY_EXTENSION = new Map<string, FileGroup>(
  Object.entries(EXTENSIONS).flatMap(([group, exts]) => exts.map((ext) => [ext, group as FileGroup] as const))
);

export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function groupOf(result: SearchResult): FileGroup {
  if (result.type === "directory") return "folders";
  return GROUP_BY_EXTENSION.get(extensionOf(result.name)) ?? "other";
}

export interface GroupCount {
  id: FileGroup;
  label: string;
  count: number;
}

/** The groups present in `results`, in pill order, with their sizes. */
export function countGroups(results: SearchResult[]): GroupCount[] {
  const counts = new Map<FileGroup, number>();
  for (const r of results) {
    const g = groupOf(r);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return GROUPS.filter((g) => counts.has(g.id)).map((g) => ({ ...g, count: counts.get(g.id)! }));
}
