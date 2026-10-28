import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { surfaceClasses } from "@/lib/surface-classes";
import { fieldTouchClass } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

// The search bar: a textarea that grows with its text up to `maxRows`, over a
// row of buttons. It looks like the compact InputMessage it replaces, without
// that chat composer's queue, attachments and suggestions (and the animation
// library and PDF renderer they pulled into every window).

interface SearchBoxProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  maxRows?: number;
  /** Green text right after what's typed: the calculator's answer. */
  ghost?: string;
  /** Under the text, on the left: a hint. */
  leftSlot?: ReactNode;
  /** Under the text, on the right: buttons. */
  rightSlot?: ReactNode;
  className?: string;
  textareaClassName?: string;
  style?: CSSProperties;
}

export const SearchBox = forwardRef<HTMLDivElement, SearchBoxProps>(
  ({ value, onValueChange, placeholder, maxRows = 4, ghost, leftSlot, rightSlot, className, textareaClassName, style }, ref) => {
    const shape = useShape();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const lineHeight = useRef(0);

    const resize = useCallback(() => {
      const el = textareaRef.current;
      if (!el) return;
      if (!lineHeight.current) lineHeight.current = parseFloat(getComputedStyle(el).lineHeight) || 18;
      el.style.height = "auto";
      const max = lineHeight.current * maxRows;
      el.style.height = `${Math.min(Math.max(el.scrollHeight, lineHeight.current), max)}px`;
      el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    }, [maxRows]);

    useLayoutEffect(resize, [value, resize]);

    // A width change rewraps the text. Width only, so the observer doesn't
    // react to its own height writes.
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      let width = el.offsetWidth;
      const observer = new ResizeObserver(() => {
        if (el.offsetWidth === width) return;
        width = el.offsetWidth;
        resize();
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [resize]);

    return (
      <div
        ref={ref}
        // A click anywhere on the bar but its buttons types into it.
        onMouseDown={(e) => {
          const target = e.target as HTMLElement;
          if (target === textareaRef.current || target.closest("button")) return;
          e.preventDefault();
          textareaRef.current?.focus();
        }}
        className={cn(
          "flex cursor-text flex-col gap-1 p-2 transition-[box-shadow,color] duration-80",
          surfaceClasses(2, 2),
          shape.container,
          className
        )}
        style={style}
      >
        {/* The ghost sits on a copy of the text laid out like the textarea's,
            so it starts where the typing ends, wrapped lines and all. */}
        <div className="relative">
          {/* The ghost is drawing only; screen readers get the answer here.
              Always there, as a live region has to exist before it changes. */}
          <span role="status" className="sr-only">
            {ghost ?? ""}
          </span>
          {ghost && (
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 overflow-hidden px-1.5 py-1.5 wrap-break-word whitespace-pre-wrap",
                "text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)]",
                fieldTouchClass,
                textareaClassName
              )}
              style={{ fontVariationSettings: fontWeights.normal }}
            >
              <span className="invisible">{value}</span>
              <span className="text-emerald-400"> {ghost}</span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={placeholder}
            rows={1}
            aria-label="Search"
            className={cn(
              "block w-full resize-none rounded-none bg-transparent px-1.5 py-1.5 outline-none",
              "text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)]",
              "text-foreground placeholder:text-muted-foreground",
              fieldTouchClass,
              textareaClassName
            )}
            style={{ fontVariationSettings: fontWeights.normal }}
          />
        </div>
        <div className="flex items-center gap-1.5 [&_button]:h-6 [&_button]:text-[length:var(--fs-caption-compact,11px)] [&_button]:leading-[var(--lh-caption-compact,14px)] [&_button.w-7]:w-6">
          {leftSlot}
          {/* ml-auto: the buttons stay right with or without a hint. */}
          <div className="ml-auto flex items-center gap-1.5">{rightSlot}</div>
        </div>
      </div>
    );
  }
);

SearchBox.displayName = "SearchBox";
