// Milestone Rail, from devl.dev (https://devl.dev/r/milestone-rail.json),
// adapted: driven by its caller instead of its own demo state (no play,
// restart or click-to-set), animated with CSS transitions instead of motion,
// and in the first-run screen's white-on-black colours, as the app has no
// shadcn colour tokens.
import { cn } from "@/lib/utils";

export interface MilestoneStep {
  id: string;
  title: string;
  description?: string;
}

export interface MilestoneRailProps {
  steps: MilestoneStep[];
  /** How many steps are finished; the one after them is the current one. */
  done: number;
  /** 0–100 for the bar, when there's finer progress than whole steps. */
  percent?: number;
  title?: string;
  className?: string;
}

const ROW = 36;
const NODE = 15;
/** Space between a circle and the rail pieces either side of it. */
const GAP = 3;
/** The tick's path length, for drawing it in with stroke-dashoffset. */
const TICK = 14;
const springy = "ease-[cubic-bezier(0.3,1.3,0.5,1)]";

export function MilestoneRail({ steps, done, percent, title = "Setup", className }: MilestoneRailProps) {
  const total = steps.length;
  const complete = done >= total;
  const pct = Math.round(Math.min(100, Math.max(0, percent ?? (Math.min(done, total) / total) * 100)));

  const activeIdx = Math.min(done, total - 1);
  const accent = complete ? "bg-emerald-400" : "bg-white";

  return (
    <section aria-label={title} className={cn("w-full text-white", className)}>
      <header className="pb-3">
        <div className="flex h-5 items-center gap-2">
          <h2 className="text-[11px] leading-4 font-medium">{title}</h2>
          <span
            aria-hidden={!complete}
            className={cn(
              "rounded-full bg-emerald-400/12 px-1.5 py-px text-[10px] font-medium text-emerald-300 transition-[opacity,scale] duration-300",
              springy,
              complete ? "scale-100 opacity-100" : "scale-75 opacity-0"
            )}
          >
            All done
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div
            aria-label="Progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={pct}
            className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
          >
            <div
              className={cn("absolute inset-0 rounded-full transition-[translate,background-color] duration-500 ease-out motion-reduce:transition-none", accent)}
              style={{ translate: `${pct - 100}% 0` }}
            />
          </div>
          <span className="w-8 text-right text-[10px] font-medium tabular-nums">{pct}%</span>
        </div>
      </header>

      <div className="relative pb-3">
        {/* The rail, in a piece between each pair of steps rather than one
            line behind them, so the circles can stay see-through over
            whatever background the rail is on. */}
        <div aria-hidden className="pointer-events-none absolute top-0 left-0" style={{ width: NODE, height: total * ROW }}>
          {steps.slice(1).map((s, i) => {
            const style = { top: i * ROW + ROW / 2 + NODE / 2 + GAP, height: ROW - NODE - 2 * GAP };
            return (
              <span key={s.id}>
                <span className="absolute left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-white/15" style={style} />
                <span
                  className={cn(
                    "absolute left-1/2 w-0.5 origin-top -translate-x-1/2 rounded-full transition-[scale,background-color] duration-500 ease-out motion-reduce:transition-none",
                    accent
                  )}
                  style={{ ...style, scale: `1 ${i < activeIdx ? 1 : 0}` }}
                />
              </span>
            );
          })}
        </div>

        <ol className="relative">
          {steps.map((s, i) => {
            const isDone = i < done;
            const isActive = i === done;
            return (
              <li key={s.id} aria-current={isActive ? "step" : undefined} className="flex items-center gap-2" style={{ height: ROW }}>
                <span className="relative flex shrink-0 items-center justify-center rounded-full" style={{ width: NODE, height: NODE }}>
                  <span
                    className={cn(
                      "absolute inset-0 rounded-full border-2 transition-colors duration-300",
                      isActive ? "border-white" : "border-white/25"
                    )}
                  />
                  {isActive && (
                    <span className="absolute inset-0 rounded-full bg-white opacity-0 motion-safe:animate-[rail-pulse_1.4s_ease-out_infinite]" />
                  )}
                  {/* Filled in once the step is done. */}
                  <span
                    className={cn(
                      "absolute inset-0 rounded-full transition-[scale,opacity,background-color] duration-300 motion-reduce:transition-none",
                      springy,
                      accent,
                      isDone ? "scale-100 opacity-100 delay-100" : "scale-40 opacity-0"
                    )}
                  />
                  {/* The tick: black on a finished step, white on the current one. */}
                  <svg
                    aria-hidden
                    className={cn("absolute size-2 transition-colors duration-300", isDone ? "text-black" : "text-white")}
                    fill="none"
                    viewBox="0 0 16 16"
                  >
                    <path
                      className={cn(
                        "transition-[stroke-dashoffset,opacity] duration-300 ease-out motion-reduce:transition-none",
                        isDone ? "delay-200" : ""
                      )}
                      d="M3.5 8.5l3 3 6-7"
                      stroke="currentColor"
                      strokeDasharray={TICK}
                      strokeDashoffset={isDone || isActive ? 0 : TICK}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.6}
                      opacity={isDone || isActive ? 1 : 0}
                    />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[11px] leading-3.5 font-medium transition-colors duration-300",
                      isDone ? "text-zinc-500" : isActive ? "text-white" : "text-zinc-400"
                    )}
                  >
                    {s.title}
                    <span className="sr-only">{isDone ? ", done" : isActive ? ", in progress" : ""}</span>
                  </span>
                  {s.description && <span className="block truncate text-[10px] leading-3.5 text-zinc-400">{s.description}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
