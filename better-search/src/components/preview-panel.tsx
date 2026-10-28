import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { SearchResult } from "@/lib/backend";
import { groupOf } from "@/lib/file-groups";
import { cachedPreview, loadPreview, type FolderEntry, type Preview } from "@/lib/preview";
import { FileIcon } from "@/components/file-icon";

/** Holding an arrow key moves through rows faster than this: only the row it
 *  stops on is loaded. */
const PREVIEW_DEBOUNCE_MS = 80;

/** Lines of a text file worth laying out; the panel shows fewer. */
const TEXT_LINES = 20;

interface PreviewPanelProps {
  result: SearchResult;
  /** Width and height, in CSS pixels. The space is kept even while there's
   *  nothing to preview, so moving between results never resizes the window
   *  (a resize moves the window a frame after the page re-lays out, which
   *  jerks the bar). */
  size: number;
  /** Physical pixels the thumbnail is fitted within. */
  thumbSize: number;
  className?: string;
  style?: CSSProperties;
}

/** The latest preview loaded, which trails the highlighted result while its
 *  own loads (showing the last one meanwhile beats flashing the square away
 *  and back with every arrow press). Null until the first one loads. */
function usePreview(result: SearchResult, thumbSize: number) {
  const [loaded, setLoaded] = useState<{ result: SearchResult; preview: Preview } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      loadPreview(result, thumbSize).then((preview) => {
        if (!cancelled) setLoaded({ result, preview });
      });
    // Already loaded (or loading): no need to wait for the keys to settle.
    if (cachedPreview(result, thumbSize)) {
      load();
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(load, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // A new search returns new objects for the same files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.path, thumbSize]);

  return loaded;
}

/** Whether a preview has anything to show; the square is left out if not. */
function hasContent(preview: Preview) {
  if (preview.kind === "text") return preview.text.trim() !== "";
  if (preview.kind === "folder") return preview.entries.length > 0;
  if (preview.kind === "page") return preview.paragraphs.length > 0;
  return preview.kind === "image";
}

/** A folder entry dressed as a result, for its icon. */
function entryResult(folder: SearchResult, entry: FolderEntry): SearchResult {
  return {
    id: 0,
    name: entry.name,
    path: `${folder.path.replace(/\\$/, "")}\\${entry.name}`,
    type: entry.dir ? "directory" : "file",
    size: 0,
    modified_at: 0,
    open_count: 0,
  };
}

// Long content fades out at the panel's edge instead of being cut mid-line.
const fadeBottom: CSSProperties = { maskImage: "linear-gradient(to bottom, black 60%, transparent)" };

function PreviewContent({ result, preview }: { result: SearchResult; preview: Preview }) {
  if (preview.kind === "image") {
    // Pages (PDFs, Office files) keep their top, where the title is.
    const page = groupOf(result) === "documents";
    return (
      <img
        src={preview.url}
        alt=""
        draggable={false}
        className={cn("h-full w-full object-cover", page && "object-top")}
      />
    );
  }

  if (preview.kind === "text") {
    const text = preview.text.split("\n", TEXT_LINES).join("\n");
    return (
      <pre
        // Wrapped: the square is narrow, and a long first line cut at its
        // edge hides most of what the file says.
        className="h-full overflow-hidden px-2 py-1.5 font-mono text-[8px] leading-[11px] wrap-break-word whitespace-pre-wrap text-zinc-300"
        style={{ ...fadeBottom, tabSize: 2 }}
      >
        {text}
      </pre>
    );
  }

  if (preview.kind === "page") {
    // The top of a white page, like the thumbnail Word would show.
    return (
      <div className="flex h-full flex-col gap-1 overflow-hidden bg-white px-2.5 py-2 text-zinc-800" style={fadeBottom}>
        {preview.paragraphs.map((p, i) => (
          <p
            key={i}
            className={cn(
              "shrink-0 break-words",
              p.heading ? "text-[8px] leading-[10px] font-semibold text-black" : "text-[6px] leading-[8px]"
            )}
          >
            {p.text}
          </p>
        ))}
      </div>
    );
  }

  if (preview.kind === "folder") {
    return (
      <div className="flex h-full flex-col overflow-hidden px-2 py-1.5" style={fadeBottom}>
        {preview.entries.map((e) => (
          <div key={e.name} className="flex h-4 shrink-0 min-w-0 items-center gap-1 text-[9px] leading-3 text-zinc-300">
            <FileIcon result={entryResult(result, e)} size={10} />
            <span className="truncate">{e.name}</span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

/** A small live preview of the highlighted result: a thumbnail, the start of a
 *  text file or a folder's contents. For results without one the square fades
 *  out, leaving its space empty. */
export function PreviewPanel({ result, size, thumbSize, className, style }: PreviewPanelProps) {
  const loaded = usePreview(result, thumbSize);
  const visible = loaded !== null && hasContent(loaded.preview);
  // What the square last showed, kept so it can fade out rather than vanish.
  const shown = useRef(loaded);
  if (visible) shown.current = loaded;
  const content = shown.current;

  return (
    <div className={cn("shrink-0", className)} style={{ width: size, height: size }}>
      <div
        className={cn(
          "h-full w-full overflow-hidden rounded-xl bg-black text-white transition-opacity duration-150",
          visible ? "opacity-100" : "opacity-0"
        )}
        style={style}
        role="region"
        aria-hidden={!visible}
        aria-label={content ? `Preview of ${content.result.name}` : undefined}
        title={content?.result.name}
      >
        {content && (
          // Keyed by file, so each new preview fades in over the square.
          <div key={content.result.path} className="h-full w-full motion-safe:animate-fade-in">
            <PreviewContent result={content.result} preview={content.preview} />
          </div>
        )}
      </div>
    </div>
  );
}
