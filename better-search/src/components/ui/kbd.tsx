import { cn } from "@/lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-[5px] bg-white/10 px-1.5 font-sans text-[11px] leading-3 font-medium text-zinc-100 shadow-[inset_0_-1px_0_rgb(255_255_255/0.08)] select-none",
        "[&_svg:not([class*='size-'])]:size-3",
        "[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

/** A shortcut as keys, like <Shortcut keys={["Ctrl", "Enter"]} />, in the middle of a sentence. */
function Shortcut({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <KbdGroup className={cn("mx-0.5 gap-0.5 align-middle", className)}>
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </KbdGroup>
  )
}

export { Kbd, KbdGroup, Shortcut }
