import { useEffect, useState } from "react";
import type { SearchResult } from "@/lib/backend";
import { groupOf } from "@/lib/file-groups";
import { iconOf } from "@/lib/file-icons";
import { imageCache } from "@/lib/image-cache";

// Icons by path (null: Windows has none), so rows asking for the same app
// share one lookup. Plenty for a few searches' apps and the browser menu.
const icons = imageCache("file_icon", 200);
const appIcons = imageCache("installed_app_icon", 200);

export function loadIcon(path: string) {
  return icons(path, { path });
}

/** A result's icon: a Start menu app's from the Apps folder, a file's from its path. */
const iconFor = (result: SearchResult) =>
  result.app_id !== undefined ? appIcons(result.app_id, { id: result.app_id }) : loadIcon(result.path);

/** An app's own icon from Windows, falling back to the generic file-type glyph. */
export function FileIcon({ result, size }: { result: SearchResult; size: number }) {
  const { Icon, color } = iconOf(result);
  const wantsReal = groupOf(result) === "apps";
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!wantsReal) return;
    let cancelled = false;
    iconFor(result).then((url) => {
      if (!cancelled) setLoaded({ path: result.path, url });
    });
    return () => {
      cancelled = true;
    };
    // An app's id is fixed by its path, so the path alone keys this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsReal, result.path]);

  const url = loaded?.path === result.path ? loaded.url : null;
  if (url) {
    return <img src={url} alt="" width={size} height={size} draggable={false} className="shrink-0 object-contain" />;
  }
  return <Icon size={size} weight="duotone" color={color} className="shrink-0" />;
}
