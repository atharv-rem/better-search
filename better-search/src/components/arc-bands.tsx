/** Dark red arc bands rising from the bottom, with a faint dot grid (after
 *  opensourceui.in's ArcBandsBackground, MIT). Fills its parent, which must be
 *  `relative isolate overflow-hidden`; the settings home and the first-run
 *  screen draw on it. `strength` (0–1) fades the red for a quieter glow. */
export function ArcBands({ strength = 1 }: { strength?: number }) {
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ opacity: strength }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-[20%] left-1/2 -z-10 h-[120%] w-[170%] -translate-x-1/2 rounded-[100%] [background:radial-gradient(ellipse_120%_88%_at_50%_100%,rgba(220,38,38,0.8)_0%,rgba(185,28,28,0.7)_25%,rgba(153,27,27,0.55)_50%,rgba(95,15,15,0.35)_72%,rgba(0,0,0,0)_92%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-[22%] left-1/2 -z-10 h-[105%] w-[145%] -translate-x-1/2 rounded-[100%] blur-2xl [background:radial-gradient(ellipse_110%_80%_at_50%_100%,rgba(239,68,68,0.5)_0%,rgba(185,28,28,0.38)_30%,rgba(127,29,29,0.2)_60%,transparent_86%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-[18%] left-1/2 -z-10 h-[85%] w-[120%] -translate-x-1/2 rounded-[100%] blur-3xl [background:radial-gradient(ellipse_100%_72%_at_50%_100%,rgba(248,113,113,0.35)_0%,rgba(153,27,27,0.18)_40%,transparent_72%)]"
        />
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 [background-image:radial-gradient(circle_at_center,#fff_1px,transparent_1px)] [background-size:4px_4px] opacity-[0.04]"
      />
    </>
  );
}
