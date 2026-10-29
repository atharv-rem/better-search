import type { ButtonHTMLAttributes, ReactNode } from "react";
import { CaretDownIcon, CheckIcon } from "@/lib/phosphor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// The settings page's building blocks, in the search bar's look: white on
// black, 12-13px type, hairline rings instead of borders.

/** A titled box of rows, divided by hairlines. */
export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <h2 className="px-1 text-[11px] leading-4 font-medium text-zinc-500">{title}</h2>}
      <div className="flex flex-col divide-y divide-white/[0.06] rounded-xl bg-[#0c0c0c] ring-1 ring-white/[0.07]">
        {children}
      </div>
      {footer && <p className="px-1 text-[11px] leading-4 text-zinc-500">{footer}</p>}
    </section>
  );
}

/** A setting: what it is on the left, its control on the right. */
export function Row({
  label,
  description,
  error,
  icon,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: string | null;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3 px-3.5 py-2">
      {icon && <span className="shrink-0 text-zinc-400">{icon}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12px] leading-4 text-white">{label}</span>
        {description && <span className="text-[11px] leading-4 text-zinc-500">{description}</span>}
        {error && (
          <span role="alert" className="text-[11px] leading-4 text-red-400">
            {error}
          </span>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** For screen readers, when the row's label isn't next to it. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-default disabled:opacity-40",
        checked ? "bg-white" : "bg-white/15 hover:bg-white/20"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-3.5 rounded-full transition-transform duration-150 motion-reduce:transition-none",
          checked ? "translate-x-3.5 bg-black" : "bg-zinc-300"
        )}
      />
    </button>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  alwaysBelow = false,
}: {
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  /** Open below even when the list doesn't fit there, scrolling instead of
   *  flipping up (long lists, which would flip every time). */
  alwaysBelow?: boolean;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="flex h-7 max-w-52 items-center gap-2 rounded-md bg-white/[0.07] px-2.5 text-[11px] leading-4 text-white outline-hidden transition-colors hover:bg-white/[0.11] focus-visible:ring-1 focus-visible:ring-[#6B97FF] data-[state=open]:bg-white/[0.11]"
      >
        {current?.icon}
        <span className="truncate">{current?.label}</span>
        <CaretDownIcon size={12} className="shrink-0 text-zinc-400" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" avoidCollisions={!alwaysBelow} className="dark min-w-40 border-white/10 bg-zinc-950 text-white">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            className="gap-2 py-1 text-[11px] leading-4 text-white focus:text-white"
            onSelect={() => onChange(o.value)}
          >
            {o.icon}
            <span className="truncate">{o.label}</span>
            {o.value === value && <CheckIcon size={14} className="ml-auto shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A choice between a few options shown side by side. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md bg-white/[0.07] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-6 rounded-[5px] px-2.5 text-[11px] leading-4 tabular-nums transition-colors",
            o.value === value ? "bg-white text-black" : "text-zinc-300 hover:text-white"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ActionButton({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] leading-4 font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "bg-white text-black hover:bg-white/90",
        variant === "secondary" && "bg-white/[0.07] text-white hover:bg-white/[0.11]",
        variant === "danger" && "bg-red-500/10 text-red-400 hover:bg-red-500/20",
        className
      )}
    />
  );
}

const MODIFIER_NAMES: Record<string, string> = { Control: "Ctrl", Super: "Win", CommandOrControl: "Ctrl", Ctrl: "Ctrl" };

/** An accelerator's keys as they're printed on a keyboard: "Control+ArrowUp"
 *  is Ctrl, Up. */
export function keysOf(accelerator: string) {
  return accelerator.split("+").map((k) => MODIFIER_NAMES[k] ?? k.replace(/^Arrow/, ""));
}

/** Keys as keycaps, side by side: a small set for in a list, a large one for
 *  the shortcut that matters most. */
export function Keys({ keys, size = "sm", className }: { keys: readonly string[]; size?: "sm" | "lg"; className?: string }) {
  return (
    <span className={cn("inline-flex items-center align-middle", size === "lg" ? "gap-2" : "gap-1", className)}>
      {keys.map((k, i) => (
        <kbd
          key={i}
          className={cn(
            "inline-flex items-center justify-center bg-gradient-to-b from-white/[0.11] to-white/[0.05] font-sans font-medium text-zinc-100 ring-1 ring-white/[0.08]",
            size === "lg"
              ? "h-11 min-w-11 rounded-lg px-3.5 text-[15px] leading-5 shadow-[inset_0_-3px_0_rgb(0_0_0/0.45),0_1px_0_rgb(255_255_255/0.04)]"
              : "h-5 min-w-5 rounded-[5px] px-1.5 text-[11px] leading-3 shadow-[inset_0_-1px_0_rgb(0_0_0/0.45)]"
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
