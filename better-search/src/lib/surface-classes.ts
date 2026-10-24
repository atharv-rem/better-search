export const SURFACE_BG: Record<number, string> = {
  1: "bg-surface-1",
  2: "bg-surface-2",
  3: "bg-surface-3",
  4: "bg-surface-4",
  5: "bg-surface-5",
  6: "bg-surface-6",
  7: "bg-surface-7",
  8: "bg-surface-8",
};

export const SURFACE_SHADOW: Record<number, string> = {
  1: "shadow-surface-1",
  2: "shadow-surface-2",
  3: "shadow-surface-3",
  4: "shadow-surface-4",
  5: "shadow-surface-5",
  6: "shadow-surface-6",
  7: "shadow-surface-7",
  8: "shadow-surface-8",
};

export const SURFACE_HOVER_BG: Record<number, string> = {
  1: "hover:bg-surface-1",
  2: "hover:bg-surface-2",
  3: "hover:bg-surface-3",
  4: "hover:bg-surface-4",
  5: "hover:bg-surface-5",
  6: "hover:bg-surface-6",
  7: "hover:bg-surface-7",
  8: "hover:bg-surface-8",
};

export const SURFACE_HOVER_SHADOW: Record<number, string> = {
  1: "hover:shadow-surface-1",
  2: "hover:shadow-surface-2",
  3: "hover:shadow-surface-3",
  4: "hover:shadow-surface-4",
  5: "hover:shadow-surface-5",
  6: "hover:shadow-surface-6",
  7: "hover:shadow-surface-7",
  8: "hover:shadow-surface-8",
};

export function surfaceClasses(bgLevel: number, shadowLevel: number = bgLevel): string {
  // Round after clamping so a fractional level can't index out of the lookup
  // tables (which would render "undefined undefined").
  const bg = Math.round(Math.max(1, Math.min(8, bgLevel)));
  const shadow = Math.round(Math.max(1, Math.min(8, shadowLevel)));
  return `${SURFACE_BG[bg]} ${SURFACE_SHADOW[shadow]}`;
}

/** The hover half of `surfaceClasses`: the level a surface rises to while the
 *  pointer is on it. Same literal-lookup reason as above — `hover:bg-surface-`
 *  plus a template expression generates nothing. */
export function surfaceHoverClasses(
  bgLevel: number,
  shadowLevel: number = bgLevel
): string {
  const bg = Math.round(Math.max(1, Math.min(8, bgLevel)));
  const shadow = Math.round(Math.max(1, Math.min(8, shadowLevel)));
  return `${SURFACE_HOVER_BG[bg]} ${SURFACE_HOVER_SHADOW[shadow]}`;
}

/** The search bar's and the settings window's shadow: a hairline ring and a
 *  soft drop. Reaches 22px out, so it fits in the 24px (p-6) of transparent
 *  window kept around those panels; a wider one would be clipped. */
export const panelShadow =
  "0 0 0 1px rgb(255 255 255 / 0.1), 0 4px 10px rgb(0 0 0 / 0.5), 0 10px 22px rgb(0 0 0 / 0.45)";

/** A shortcut in a sentence, like "Ctrl + Enter", as one pill in the
 *  settings shortcut button's look. */
export const shortcutPill =
  "mx-0.5 inline-flex h-5 items-center rounded-md bg-white/[0.07] px-1.5 align-middle text-[11px] leading-3 font-medium text-zinc-100";
