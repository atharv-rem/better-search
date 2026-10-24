import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"

// A small menu: a button that opens a list of items under it. It keeps the
// API this app used from Radix's DropdownMenu, without Radix and its
// positioning library, which were a fifth of the search window's code.
//
// Keyboard: Enter, Space or ArrowDown on the trigger opens it; arrows, Home
// and End move between items; Enter or Space picks one; Escape or Tab closes.

interface MenuState {
  open: boolean
  setOpen: (open: boolean, focusFirst?: boolean) => void
  focusFirst: boolean
  triggerRef: React.RefObject<HTMLButtonElement | null>
  contentId: string
}

const MenuContext = React.createContext<MenuState | null>(null)

function useMenu() {
  const menu = React.useContext(MenuContext)
  if (!menu) throw new Error("DropdownMenu parts must be inside a DropdownMenu")
  return menu
}

function DropdownMenu({
  children,
  onOpenChange,
}: {
  children: React.ReactNode
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpenState] = React.useState(false)
  const [focusFirst, setFocusFirst] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const contentId = React.useId()
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const setOpen = React.useCallback((next: boolean, first = false) => {
    setFocusFirst(first)
    setOpenState((prev) => {
      if (prev !== next) onOpenChangeRef.current?.(next)
      return next
    })
  }, [])

  const value = React.useMemo(
    () => ({ open, setOpen, focusFirst, triggerRef, contentId }),
    [open, setOpen, focusFirst, contentId]
  )
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>
}

function DropdownMenuTrigger({ onClick, onKeyDown, ...props }: React.ComponentProps<"button">) {
  const menu = useMenu()
  return (
    <button
      ref={menu.triggerRef}
      type="button"
      data-slot="dropdown-menu-trigger"
      aria-haspopup="menu"
      aria-expanded={menu.open}
      aria-controls={menu.open ? menu.contentId : undefined}
      data-state={menu.open ? "open" : "closed"}
      onClick={(e) => {
        onClick?.(e)
        // A keyboard "click" (Enter, Space) is handled in onKeyDown.
        if (!e.defaultPrevented && e.detail !== 0) menu.setOpen(!menu.open)
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented) return
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
          e.preventDefault()
          menu.setOpen(true, true)
        }
      }}
      {...props}
    />
  )
}

function items(content: HTMLElement) {
  return Array.from(content.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])'))
}

function DropdownMenuContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  avoidCollisions = true,
  onCloseAutoFocus,
  children,
  style,
  ...props
}: Omit<React.ComponentProps<"div">, "onKeyDown"> & {
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
  sideOffset?: number
  /** Flip above the trigger when there isn't room below (and vice versa). */
  avoidCollisions?: boolean
  /** Called as the menu closes; preventDefault keeps focus off the trigger. */
  onCloseAutoFocus?: (event: Event) => void
}) {
  const menu = useMenu()
  const ref = React.useRef<HTMLDivElement>(null)
  const [position, setPosition] = React.useState<React.CSSProperties & { side: string }>()
  const closeAutoFocus = React.useRef(onCloseAutoFocus)
  closeAutoFocus.current = onCloseAutoFocus

  // Under (or over) the trigger, kept on screen. Recomputed when the window
  // resizes, as the search window grows to make room for the menu.
  React.useLayoutEffect(() => {
    if (!menu.open) return
    const place = () => {
      const trigger = menu.triggerRef.current
      const content = ref.current
      if (!trigger || !content) return
      const t = trigger.getBoundingClientRect()
      const width = content.offsetWidth
      const below = innerHeight - t.bottom - sideOffset
      const above = t.top - sideOffset
      const flip = avoidCollisions && content.scrollHeight > (side === "bottom" ? below : above)
      const actual = flip ? (side === "bottom" ? "top" : "bottom") : side
      const x = align === "start" ? t.left : align === "end" ? t.right - width : t.left + (t.width - width) / 2
      setPosition({
        side: actual,
        left: Math.max(0, Math.min(x, innerWidth - width)),
        ...(actual === "bottom"
          ? { top: t.bottom + sideOffset, maxHeight: below }
          : { bottom: innerHeight - t.top + sideOffset, maxHeight: above }),
      })
    }
    place()
    addEventListener("resize", place)
    return () => removeEventListener("resize", place)
  }, [menu.open, menu.triggerRef, side, align, sideOffset, avoidCollisions])

  // Focus moves into the menu on open and back out on close.
  React.useEffect(() => {
    if (!menu.open) return
    const content = ref.current
    if (menu.focusFirst) (content && items(content)[0])?.focus()
    else content?.focus()
    const trigger = menu.triggerRef.current
    return () => {
      const event = new Event("closeAutoFocus", { cancelable: true })
      closeAutoFocus.current?.(event)
      if (!event.defaultPrevented) trigger?.focus()
    }
  }, [menu.open, menu.focusFirst, menu.triggerRef])

  // A press anywhere outside closes it.
  React.useEffect(() => {
    if (!menu.open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || menu.triggerRef.current?.contains(target)) return
      menu.setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [menu])

  if (!menu.open) return null
  const { side: placedSide, ...placement } = position ?? { side }

  return createPortal(
    <div
      ref={ref}
      id={menu.contentId}
      role="menu"
      tabIndex={-1}
      data-slot="dropdown-menu-content"
      data-state="open"
      data-side={placedSide}
      onKeyDown={(e) => {
        const all = items(e.currentTarget)
        const at = all.indexOf(document.activeElement as HTMLElement)
        const move = (i: number) => all[Math.max(0, Math.min(i, all.length - 1))]?.focus()
        if (e.key === "ArrowDown") move(at + 1)
        else if (e.key === "ArrowUp") move(at < 0 ? all.length - 1 : at - 1)
        else if (e.key === "Home") move(0)
        else if (e.key === "End") move(all.length - 1)
        else if (e.key === "Escape" || e.key === "Tab") menu.setOpen(false)
        else return
        // Also tells the search window's Escape handler the menu took it.
        e.preventDefault()
      }}
      className={cn(
        "fixed z-50 min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-hidden",
        className
      )}
      // Measured hidden on the first frame, then placed.
      style={{ ...placement, ...(position ? null : { visibility: "hidden", top: 0, left: 0 }), ...style }}
      {...props}
    >
      {children}
    </div>,
    document.body
  )
}

function DropdownMenuItem({
  className,
  onSelect,
  disabled,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "onSelect"> & {
  onSelect?: () => void
  disabled?: boolean
}) {
  const menu = useMenu()
  const select = () => {
    if (disabled) return
    menu.setOpen(false)
    onSelect?.()
  }
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      data-slot="dropdown-menu-item"
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      // The pointer highlights an item by focusing it, as the keyboard does.
      onPointerMove={(e) => e.currentTarget !== document.activeElement && e.currentTarget.focus()}
      onPointerLeave={(e) => e.currentTarget.closest<HTMLElement>('[role="menu"]')?.focus()}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        select()
      }}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem }
