import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { fontWeights } from "@/lib/font-weight";
import { ArrowUpIcon } from "@/lib/phosphor";
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
  /** The arrow button, as Enter; `ctrl` for a Ctrl+click. */
  onSubmit?: (ctrl: boolean) => void;
  /** Buttons left of the arrow. */
  rightSlot?: ReactNode;
  className?: string;
  textareaClassName?: string;
  style?: CSSProperties;
}

export const SearchBox = forwardRef<HTMLDivElement, SearchBoxProps>(
  ({ value, onValueChange, placeholder, maxRows = 4, onSubmit, rightSlot, className, textareaClassName, style }, ref) => {
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
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          rows={1}
          aria-label="Search"
          className={cn(
            "w-full resize-none rounded-none bg-transparent px-1.5 py-1.5 outline-none",
            "text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)]",
            "text-foreground placeholder:text-muted-foreground",
            fieldTouchClass,
            textareaClassName
          )}
          style={{ fontVariationSettings: fontWeights.normal }}
        />
        <div className="flex items-center justify-end gap-1.5 [&_button]:h-6 [&_button]:text-[length:var(--fs-caption-compact,11px)] [&_button]:leading-[var(--lh-caption-compact,14px)] [&_button.w-7]:w-6">
          {rightSlot}
          <Button
            type="button"
            variant="primary"
            size="icon-sm"
            disabled={!value.trim()}
            aria-label="Open"
            // Keeps the caret in the box, so typing carries on after a click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => onSubmit?.(e.ctrlKey)}
          >
            <ArrowUpIcon size={15} className="block h-[15px]! w-[15px]!" />
          </Button>
        </div>
      </div>
    );
  }
);

SearchBox.displayName = "SearchBox";
