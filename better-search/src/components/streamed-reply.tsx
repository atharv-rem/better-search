// devl.dev's Streamed Reply (https://devl.dev/r/streamed-reply.json), fed a
// real answer as it streams in rather than a finished one to play back, and
// in the search window's look: white on black, Phosphor icons, the sites' own
// favicons. Words fade in at a steady pace whatever the network does, and the
// card holds the size of the text received so far, so it only ever grows.
// Its motion is CSS only (the keyframes are in App.css), and stops when
// Windows' animation effects are off.
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "@/components/ui/preview-card";
import { Favicon, siteOf } from "@/components/web-results";
import { ArrowsClockwiseIcon, CheckIcon, ClipboardTextIcon } from "@/lib/phosphor";
import { cn } from "@/lib/utils";

export interface ReplySource {
  title: string;
  url: string;
  snippet: string;
}

export interface StreamedReplyProps {
  /** The answer so far. */
  answer: string;
  /** What [n] in the answer points at, in order. */
  sources: ReplySource[];
  /** "reading": the sources (or the model) before the first word;
   *  "streaming": words still arriving; "done": the answer is complete. */
  status: "reading" | "streaming" | "done";
  /** Shown while reading, like "Reading 5 sources…". */
  readingLabel?: string;
  /** Words per tick at the least; the pace picks up when words pile up. */
  speed?: number;
  /** CSS pixels; the answer scrolls beyond it. */
  maxHeight?: number;
  /** At the end of the actions row once done, like the model's name. */
  footnote?: ReactNode;
  onRegenerate?: () => void;
  onOpenSource?: (source: ReplySource) => void;
  className?: string;
}

const easeOut = "ease-[cubic-bezier(0.23,1,0.32,1)]";
const press = "transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.97]";
const focusRing = "outline-hidden focus-visible:ring-1 focus-visible:ring-[#6B97FF]";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Windows' "Animation effects" is off. */
function useReducedMotion() {
  return useSyncExternalStore(
    (onChange) => {
      reducedMotion.addEventListener("change", onChange);
      return () => reducedMotion.removeEventListener("change", onChange);
    },
    () => reducedMotion.matches
  );
}

type Part ={ kind: "text"; text: string } | { kind: "cite"; n: number };
type Token = { kind: "space" } | { kind: "word"; parts: Part[] };

/** Models write Markdown now and then though asked not to: drop its marks. */
function plainText(answer: string) {
  return answer
    .replace(/\*\*|__/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    // "[1][2]" and "[1, 2]" are two citations.
    .replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, list: string) => list.split(/\s*,\s*/).map((n) => `[${n}]`).join(""));
}

function tokenize(answer: string): Token[][] {
  return plainText(answer)
    .trim()
    .replace(/[ \t]+(\[\d+\])/g, "$1")
    .split(/\n\s*\n/)
    .map((para) =>
      para
        .split(/([ \t\n]+)/)
        .filter(Boolean)
        .map((chunk): Token => {
          if (/^[ \t\n]+$/.test(chunk)) return { kind: "space" };
          const parts = chunk
            .split(/(\[\d+\])/)
            .filter(Boolean)
            .map((part): Part => {
              const cite = /^\[(\d+)\]$/.exec(part);
              return cite ? { kind: "cite", n: Number(cite[1]) } : { kind: "text", text: part };
            });
          // "claim[1]." reads as "claim.[1]".
          const last = parts[parts.length - 1];
          const prev = parts[parts.length - 2];
          if (last?.kind === "text" && prev?.kind === "cite" && /^[.,;:!?]+$/.test(last.text)) {
            let i = parts.length - 2;
            while (parts[i - 1]?.kind === "cite") i--;
            parts.splice(parts.length - 1, 1);
            const before = parts[i - 1];
            if (before?.kind === "text") before.text += last.text;
            else parts.splice(i, 0, last);
          }
          return { kind: "word", parts };
        })
    );
}

export function StreamedReply({
  answer,
  sources,
  status,
  readingLabel,
  speed = 38,
  maxHeight,
  footnote,
  onRegenerate,
  onOpenSource,
  className,
}: StreamedReplyProps) {
  const reduce = useReducedMotion();
  const paragraphs = useMemo(() => tokenize(answer), [answer]);
  const total = useMemo(() => paragraphs.reduce((n, p) => n + p.length, 0), [paragraphs]);
  // While words still arrive the last one may be cut off: hold it back.
  const ready = status === "done" ? total : Math.max(0, total - 1);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (reduce) {
      setShown(ready);
      return;
    }
    if (shown >= ready) return;
    // A steady pace, catching up when the model is faster than it.
    const step = Math.max(1 + Math.round(Math.random() * 2), Math.ceil((ready - shown) / 12));
    const timer = setTimeout(() => setShown((s) => Math.min(ready, s + step)), speed + Math.random() * speed);
    return () => clearTimeout(timer);
  }, [shown, ready, speed, reduce]);

  const phase = shown === 0 && status !== "done" ? "reading" : status === "done" && shown >= total ? "done" : "streaming";
  const done = phase === "done";
  const plain = plainText(answer).replace(/\s?\[\d+\]/g, "");

  // Keeps the newest words in view while they arrive, and the whole answer
  // once done, unless the user has scrolled up to read. It follows the words
  // shown, not the invisible copy sizing the card, which runs ahead of them.
  const scroller = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Where this effect last scrolled to: a scroll event above it is the user's.
  const autoTop = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    let end = el.scrollHeight;
    if (!done && words.current) {
      const box = el.getBoundingClientRect();
      end = Math.min(end, words.current.getBoundingClientRect().bottom - box.top + el.scrollTop);
    }
    el.scrollTop = end - el.clientHeight;
    autoTop.current = el.scrollTop;
  }, [shown, total, done]);

  let index = 0;

  return (
    <article className={cn("flex flex-col text-[12px] leading-5 text-white", className)}>
      <div
        ref={scroller}
        // Scroll events land a frame after the scroll, by when more words may
        // have arrived, so being short of the bottom alone doesn't let go: only
        // a move up does, and coming back down to the end takes hold again.
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop < autoTop.current - 2) pinned.current = false;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) pinned.current = true;
          autoTop.current = el.scrollTop;
        }}
        onWheel={(e) => {
          if (e.deltaY < 0) pinned.current = false;
        }}
        // The effect above does the anchoring; the browser's own would follow
        // the invisible copy instead.
        className="overflow-y-auto p-3 pb-0 select-text [overflow-anchor:none]"
        style={{ maxHeight }}
      >
        {sources.length > 0 && (
          <div aria-label="Sources" className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1" role="list">
            {sources.map((src, i) => (
              <button
                type="button"
                className={cn(
                  "flex min-w-36 flex-1 basis-0 flex-col gap-1.5 rounded-lg bg-white/[0.04] p-2 text-start ring-1 ring-white/[0.07] hover:bg-white/[0.08] motion-safe:animate-card-in",
                  focusRing,
                  press
                )}
                key={src.url}
                onClick={() => onOpenSource?.(src)}
                role="listitem"
                style={{ animationDelay: `${100 + i * 40}ms` }}
                title={src.url}
              >
                <span className="flex items-center gap-1.5 text-[11px] leading-4 text-zinc-400">
                  <Favicon url={src.url} size={12} />
                  <span className="truncate">{siteOf(src.url)}</span>
                  <span className="ms-auto font-mono tabular-nums">{i + 1}</span>
                </span>
                <span className="line-clamp-2 text-[11px] leading-4 text-zinc-200">{src.title}</span>
              </button>
            ))}
          </div>
        )}

        {/* An invisible copy of the answer received so far sizes the card
            ahead of the words fading in. */}
        <div className="grid *:col-start-1 *:row-start-1">
          <div aria-hidden className="invisible">
            {paragraphs.map((tokens, pi) => (
              <p className="mb-2.5 last:mb-0" key={pi}>
                {tokens.map((tok, ti) =>
                  tok.kind === "space" ? (
                    <span key={ti}> </span>
                  ) : (
                    <span className="whitespace-nowrap" key={ti}>
                      {tok.parts.map((part, k) =>
                        part.kind === "cite" ? (
                          sources[part.n - 1] ? (
                            <span className={chip} key={k}>
                              {part.n}
                            </span>
                          ) : null
                        ) : (
                          <span key={k}>{part.text}</span>
                        )
                      )}
                    </span>
                  )
                )}
              </p>
            ))}
          </div>
          <div ref={words} aria-busy={!done} aria-live="polite" className="self-start">
            {phase === "reading" ? (
              <div className="flex flex-col">
                <Shimmer>{readingLabel ?? "Thinking…"}</Shimmer>
                <div aria-hidden className="mt-2 flex flex-col gap-2.5">
                  {["w-full", "w-11/12", "w-3/5"].map((w) => (
                    <span className={cn("h-2.5 rounded-full bg-white/[0.07]", w)} key={w} />
                  ))}
                </div>
              </div>
            ) : (
              paragraphs.map((tokens, pi) => (
                <p className="mb-2.5 text-zinc-100 last:mb-0" key={pi}>
                  {tokens.map((tok, ti) => {
                    const at = index++;
                    if (at >= shown) return null;
                    const key = `${pi}-${ti}`;
                    if (tok.kind === "space") return <span key={key}> </span>;
                    return (
                      <span className="whitespace-nowrap" key={key}>
                        {tok.parts.map((part, k) => {
                          if (part.kind === "cite") {
                            const src = sources[part.n - 1];
                            return src ? <Citation key={k} n={part.n} source={src} onOpen={onOpenSource} /> : null;
                          }
                          return (
                            <span className="motion-safe:animate-word-in" key={k}>
                              {part.text}
                            </span>
                          );
                        })}
                      </span>
                    );
                  })}
                  {phase === "streaming" && caretInParagraph(pi, paragraphs, shown) && <Caret />}
                </p>
              ))
            )}
          </div>
        </div>
      </div>

      <div
        className={cn(
          "px-3 pb-2 transition-[opacity,translate] motion-reduce:transition-none",
          easeOut,
          done ? "translate-y-0 opacity-100 duration-250" : "pointer-events-none translate-y-1 opacity-0 duration-120"
        )}
        inert={!done}
      >
        <Actions text={plain} onRegenerate={onRegenerate} footnote={footnote} />
      </div>
    </article>
  );
}

function caretInParagraph(pi: number, paragraphs: Token[][], shown: number) {
  let start = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const end = start + paragraphs[i].length;
    if (shown <= end || i === paragraphs.length - 1) return i === pi;
    start = end;
  }
  return false;
}

const chip =
  "ms-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 align-[1px] font-mono text-[10px] font-medium leading-none tabular-nums";

function Citation({ n, source, onOpen }: { n: number; source: ReplySource; onOpen?: (source: ReplySource) => void }) {
  return (
    <PreviewCard>
      <PreviewCardTrigger
        aria-label={`Source ${n}: ${source.title}`}
        className={cn(
          chip,
          "relative cursor-pointer bg-white/10 text-zinc-300 no-underline transition-colors duration-150 after:absolute after:-inset-x-1.5 after:-inset-y-2 hover:bg-white hover:text-black data-popup-open:bg-white data-popup-open:text-black motion-safe:animate-pop-in",
          focusRing
        )}
        closeDelay={120}
        delay={150}
        href={source.url}
        // In the app's webview a link would leave the page: the browser opens it.
        onClick={(e) => {
          e.preventDefault();
          onOpen?.(source);
        }}
        render={<a />}
      >
        {n}
      </PreviewCardTrigger>
      <PreviewCardPopup
        className="dark w-72 flex-col gap-1.5 rounded-lg border-white/10 bg-zinc-950 p-3 text-pretty text-white shadow-lg duration-150 ease-out"
        sideOffset={6}
      >
        <span className="flex items-center gap-1.5 text-[11px] leading-4 text-zinc-400">
          <Favicon url={source.url} size={12} />
          <span className="truncate">{siteOf(source.url)}</span>
          <span className="ms-auto font-mono tabular-nums">[{n}]</span>
        </span>
        <span className="text-[12px] leading-4 font-medium text-white">{source.title}</span>
        {source.snippet && <span className="line-clamp-4 text-[11px] leading-4 text-zinc-400">{source.snippet}</span>}
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function Caret() {
  return (
    <span aria-hidden className="ms-1 inline-block size-2 rounded-full bg-white align-[1px] motion-safe:animate-caret" />
  );
}

function Shimmer({ children }: { children: string }) {
  return (
    <span
      className="self-start bg-clip-text font-medium text-transparent motion-safe:animate-shimmer"
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--color-zinc-500) 35%, var(--color-white) 50%, var(--color-zinc-500) 65%)",
        backgroundSize: "200% 100%",
      }}
    >
      {children}
    </span>
  );
}

/** The copy and check icons share a spot; the one not shown shrinks into a blur. */
const iconSwap = "col-start-1 row-start-1 transition-[opacity,scale,filter] duration-180 motion-reduce:transition-none";

function Actions({ text, onRegenerate, footnote }: { text: string; onRegenerate?: () => void; footnote?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [spins, setSpins] = useState(0);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Nothing copied, nothing to confirm.
    }
  };

  const btn = cn(
    "relative grid size-7 place-items-center rounded-md text-zinc-400 hover:bg-white/[0.07] hover:text-white",
    focusRing,
    press
  );

  return (
    <div className="-ms-1.5 mt-2 flex h-7 items-center gap-0.5">
      <button aria-label={copied ? "Copied" : "Copy answer"} title="Copy answer" className={btn} onClick={copy} type="button">
        <span className="grid">
          <ClipboardTextIcon size={15} className={cn(iconSwap, easeOut, copied && "scale-60 opacity-0 blur-[2px]")} />
          <CheckIcon size={15} className={cn(iconSwap, easeOut, "text-emerald-400", !copied && "scale-60 opacity-0 blur-[2px]")} />
        </span>
      </button>
      {onRegenerate && (
        <button
          aria-label="Ask again"
          title="Ask again"
          className={btn}
          onClick={() => {
            setSpins((n) => n + 1);
            onRegenerate();
          }}
          type="button"
        >
          {/* A whole turn per press; without animations it just stays put. */}
          <span
            className={cn("grid transition-[rotate] duration-500 motion-reduce:transition-none", easeOut)}
            style={{ rotate: `${spins * 360}deg` }}
          >
            <ArrowsClockwiseIcon size={15} />
          </span>
        </button>
      )}
      {footnote && <span className="ms-auto min-w-0 truncate text-[11px] leading-4 text-zinc-500">{footnote}</span>}
    </div>
  );
}
