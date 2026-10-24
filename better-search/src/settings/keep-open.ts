// The settings window closes when it loses focus (a click outside it). Things
// that take focus away on purpose (a folder picker, Windows' permission
// prompt, the browser or Explorer) hold it open while they run.

let holds = 0;

export const isHeldOpen = () => holds > 0;

/** Keeps the window open while `work` runs, and a moment after, for focus to come back. */
export function keepOpenWhile<T>(work: Promise<T>): Promise<T> {
  holds++;
  return work.finally(() => setTimeout(() => holds--, 600));
}

/** Keeps the window open a few seconds, for something that opens in another app. */
export function keepOpenFor(ms = 4000) {
  holds++;
  setTimeout(() => holds--, ms);
}
