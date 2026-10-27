import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowClockwiseIcon, CheckIcon, ClipboardTextIcon, FileTextIcon } from "@/lib/phosphor";
import { cn } from "@/lib/utils";
import { ActionButton, Group, Row } from "@/settings/controls";
import { keepOpenFor } from "@/settings/keep-open";

type Level = "error" | "warn";

/** A warning or error from the log file (logs.rs). */
interface Problem {
  date: string; // 2026-10-27
  time: string; // 07:43:28
  level: Level;
  source: string; // app, backend, indexer, watcher, updater
  message: string;
}

const LEVELS: { level: Level; name: string; tag: string; dot: string; text: string; row: string }[] = [
  { level: "error", name: "Error", tag: "ERR", dot: "bg-red-400", text: "text-red-400", row: "bg-red-500/[0.06]" },
  { level: "warn", name: "Warn", tag: "WRN", dot: "bg-amber-400", text: "text-amber-400", row: "bg-amber-500/[0.05]" },
];
const style = (level: Level) => LEVELS.find((l) => l.level === level)!;

/** "07:43:28" for today, "Oct 27 07:43:28" before. */
function when(p: Problem) {
  const today = new Date();
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (p.date === local) return p.time;
  const [y, m, d] = p.date.split("-").map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} ${p.time}`;
}

export function TroubleshootingSection() {
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<Level, boolean>>({ error: true, warn: true });
  const [copied, setCopied] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<Problem[]>("recent_problems")
      .then((found) => {
        setProblems(found);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);
  useEffect(load, [load]);

  const visible = problems?.filter((p) => shown[p.level]) ?? [];
  const count = (level: Level) => problems?.filter((p) => p.level === level).length ?? 0;

  const copy = () => {
    const text = visible.map((p) => `${p.date} ${p.time} ${style(p.level).tag} ${p.source}  ${p.message}`).join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((err) => setError(`Couldn't copy: ${err}`));
  };

  return (
    <>
      <Group
        title="Problems"
        footer="Warnings and errors from the app, the indexer and the file watcher. Copy them into a bug report to help track a problem down."
      >
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          {LEVELS.map(({ level, name, dot }) => (
            <button
              key={level}
              type="button"
              aria-pressed={shown[level]}
              onClick={() => setShown((s) => ({ ...s, [level]: !s[level] }))}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] leading-4 ring-1 transition-colors outline-hidden focus-visible:ring-[#6B97FF]",
                shown[level]
                  ? "bg-white/[0.07] text-white ring-white/[0.08] hover:bg-white/[0.11]"
                  : "text-zinc-500 ring-white/[0.05] hover:text-zinc-300"
              )}
            >
              <span className={cn("size-1.5 rounded-full", dot, !shown[level] && "opacity-40")} />
              {name}
              <span className="text-zinc-500 tabular-nums">{count(level)}</span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <ActionButton onClick={load} aria-label="Refresh">
              <ArrowClockwiseIcon size={14} />
            </ActionButton>
            <ActionButton onClick={copy} disabled={visible.length === 0}>
              {copied ? <CheckIcon size={14} /> : <ClipboardTextIcon size={14} />}
              {copied ? "Copied" : "Copy"}
            </ActionButton>
          </div>
        </div>

        {error && (
          <p role="alert" className="px-3.5 py-2 text-[11px] leading-4 text-red-400">
            {error}
          </p>
        )}

        {problems === null ? (
          !error && <div className="m-2.5 h-24 animate-pulse rounded-lg bg-white/[0.04]" role="status" aria-label="Loading" />
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-3.5 py-8 text-center">
            <CheckIcon size={16} className="text-emerald-400" />
            <span className="text-[12px] leading-4 text-white">
              {problems.length === 0 ? "No problems logged" : "Nothing to show"}
            </span>
            <span className="text-[11px] leading-4 text-zinc-500">
              {problems.length === 0 ? "Better Search hasn't run into anything." : "Turn on a level above to see its entries."}
            </span>
          </div>
        ) : (
          <ol className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)] py-1 font-mono text-[11px] leading-4">
            {visible.map((p, i) => {
              const s = style(p.level);
              return (
                <li key={i} className={cn("col-span-4 grid grid-cols-subgrid gap-x-3 px-3.5 py-1.5", s.row)}>
                  <span className="text-zinc-500 tabular-nums">{when(p)}</span>
                  <span className={cn("font-semibold", s.text)}>{s.tag}</span>
                  <span className="text-zinc-500">{p.source}</span>
                  <span className="break-words whitespace-pre-wrap text-zinc-100">{p.message}</span>
                </li>
              );
            })}
          </ol>
        )}
      </Group>

      <Group>
        <Row label="Logs" description="Everything the app and the indexer wrote while running." error={logsError}>
          <ActionButton
            onClick={() => {
              keepOpenFor();
              invoke("open_logs_folder")
                .then(() => setLogsError(null))
                .catch((err) => setLogsError(String(err)));
            }}
          >
            <FileTextIcon size={14} />
            Open logs folder
          </ActionButton>
        </Row>
      </Group>
    </>
  );
}
