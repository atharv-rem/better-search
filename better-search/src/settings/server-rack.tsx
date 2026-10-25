import { useEffect, useMemo, useRef, useState } from "react";
import "@/settings/server-rack.css";

/** One thing mounted in the rack. Its properties are read off the labels beside it. */
export type RackUnit = {
  /** Running and lit, switched off (excluded), busy (being read), or running with no status lamp. */
  lamp: "on" | "off" | "busy" | "none";
  title: string;
  detail?: string;
  /** 0–1: the fill of the bar on the unit's front. */
  fraction?: number;
  /** Draws the detail line as a warning. */
  warn?: boolean;
  /** The one lit part: the controller. */
  lit?: boolean;
};

type Slot = RackUnit | null;

// The iso-glow kernel: +x runs down-right, +y down-left, +z up.
const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);

const WIDTH = 620;
const SCALE = 1.9;
const MIN_DRIVE_SLOTS = 4;

// World units.
const W = 92;
const D = 32;
const U = 16;
const BASE = 5;
const CAP = 2.4;
const POST = 4;
const INSET = 5;
const FACE_Y = D - 3;
const UNIT_W = W - INSET * 2;
const UNIT_H = U - 1.2;
const PAD = 16;

type Cam = {
  P: (x: number, y: number, z: number) => [number, number];
  plane: (x: number, y: number, z: number, side: "front" | "side" | "top") => string;
};

const f = (n: number) => Math.round(n * 10) / 10;

function camera(ox: number, oy: number): Cam {
  const P = (x: number, y: number, z: number): [number, number] => [ox + (x - y) * C * SCALE, oy + ((x + y) * S - z) * SCALE];
  const D3 = (x: number, y: number, z: number): [number, number] => [(x - y) * C * SCALE, ((x + y) * S - z) * SCALE];
  const matrix = (o: [number, number], u: [number, number], v: [number, number]) =>
    `matrix(${f(u[0])} ${f(u[1])} ${f(v[0])} ${f(v[1])} ${f(o[0])} ${f(o[1])})`;
  return {
    P,
    // A face's top-left corner, with local x along the face and y down it.
    plane: (x, y, z, side) =>
      side === "front"
        ? matrix(P(x, y, z), D3(1, 0, 0), D3(0, 0, -1))
        : side === "side"
          ? matrix(P(x, y, z), D3(0, -1, 0), D3(0, 0, -1))
          : matrix(P(x, y, z), D3(1, 0, 0), D3(0, 1, 0)),
  };
}

const poly = (points: [number, number][]) => `M${points.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;

/** The three faces of a box that show: top, the y-max face and the x-max face. */
function boxPaths(cam: Cam, x: number, y: number, z: number, w: number, d: number, h: number) {
  const { P } = cam;
  return {
    top: poly([P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)]),
    front: poly([P(x, y + d, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z), P(x, y + d, z)]),
    side: poly([P(x + w, y, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z), P(x + w, y, z)]),
  };
}

function Box({ paths, className }: { paths: ReturnType<typeof boxPaths>; className?: string }) {
  return (
    <g className={className ? `rk-box ${className}` : "rk-box"}>
      <path className="rk-face rk-side" d={paths.side} />
      <path className="rk-face rk-front" d={paths.front} />
      <path className="rk-face rk-top" d={paths.top} />
    </g>
  );
}

function build(count: number) {
  const z0 = BASE;
  const height = z0 + count * U + CAP;
  const bare = camera(0, 0);
  const corners: [number, number][] = [];
  for (const x of [-2, W + 2]) for (const y of [-2, D + 2]) for (const z of [0, height]) corners.push(bare.P(x, y, z));
  const left = Math.min(...corners.map((p) => p[0]));
  const right = Math.max(...corners.map((p) => p[0]));
  const up = Math.min(...corners.map((p) => p[1]));
  const down = Math.max(...corners.map((p) => p[1]));
  const cam = camera(WIDTH / 2 - (left + right) / 2, PAD - up);
  const rackLeft = WIDTH / 2 - (right - left) / 2;
  return { cam, z0, height, rackLeft, rackRight: rackLeft + (right - left), viewHeight: Math.ceil(down - up + PAD * 2) };
}

/**
 * The index as a small server rack, in the middle of the page. A controller
 * on top, one server per drive, the storage below. Each front shows what the
 * machine is doing: a power lamp, drive bays whose lights flicker with disk
 * activity, a fan that spins while it runs (faster while the drive is read)
 * and a used-space bar. The labels at both sides, each with an arrow, give
 * the numbers.
 */
export function ServerRack({ top, bottom, indexing }: { top: RackUnit[]; bottom: RackUnit[]; indexing: boolean }) {
  // Short racks are filled up with blanking panels, between the drives and the storage.
  const blanks = Math.max(0, MIN_DRIVE_SLOTS + 1 - top.length);
  // Slots run bottom to top, so each unit hides the one behind it.
  const slots: Slot[] = useMemo(
    () => [...bottom, ...Array<Slot>(blanks).fill(null), ...[...top].reverse()],
    [top, bottom, blanks]
  );
  const g = useMemo(() => build(slots.length), [slots.length]);
  const { cam, z0 } = g;

  const labelLeft = Math.floor(g.rackLeft) - 34;

  // Pointing at a unit (or its label) puts it in the light and dims the rest.
  // Pressing it runs the "locate" a real server has: its lamps blink for a few seconds.
  const [active, setActive] = useState<number | null>(null);
  const [located, setLocated] = useState<number | null>(null);
  const locateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(locateTimer.current), []);
  const locate = (i: number) => {
    clearTimeout(locateTimer.current);
    setLocated(i);
    locateTimer.current = setTimeout(() => setLocated(null), 3000);
  };
  // The lights and fans only run while the window is visible and focused.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const sync = () => setPaused(document.hidden || !document.hasFocus());
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  const anyLit = slots.some((u) => u && (u.lamp === "on" || u.lamp === "busy"));
  const label = `A server rack holding the index: ${top.map((u) => u.title).join(", ")}.`;

  return (
    <div className="rack" data-indexing={indexing ? "" : undefined} data-paused={paused ? "" : undefined}>
      <svg
        className="rk-svg"
        viewBox={`0 0 ${WIDTH} ${g.viewHeight}`}
        role="group"
        aria-label={label}
        focusable="false"
        data-hover={active !== null ? "" : undefined}
      >
        <defs>
          <filter id="rk-glow" filterUnits="userSpaceOnUse" x="-20" y="-20" width={WIDTH + 40} height={g.viewHeight + 40}>
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="rk-leader" gradientUnits="userSpaceOnUse" x1={labelLeft + 8} y1="0" x2={g.cam.P(INSET, FACE_Y, 0)[0]} y2="0">
            <stop offset="0" stopColor="#71717a" stopOpacity="0.35" />
            <stop offset="1" stopColor="#a1a1aa" />
          </linearGradient>
        </defs>

        {/* The light pools on the floor, the shape of the plinth it stands on. */}
        {anyLit && (
          <g className="rk-halo">
            {[12, 8, 4].map((m) => (
              <path key={m} d={poly([cam.P(-m, -m, 0), cam.P(W + m, -m, 0), cam.P(W + m, D + m, 0), cam.P(-m, D + m, 0)])} />
            ))}
          </g>
        )}

        <Box paths={boxPaths(cam, -2, -2, 0, W + 4, D + 4, BASE)} className="rk-plinth" />
        <Box paths={boxPaths(cam, 0, 0, z0, POST, POST, g.height - z0 - CAP)} />
        <Box paths={boxPaths(cam, W - POST, 0, z0, POST, POST, g.height - z0 - CAP)} />

        {slots.map((unit, i) => {
          const zTop = z0 + i * U + 0.6 + UNIT_H;
          const paths = boxPaths(cam, INSET, 3, z0 + i * U + 0.6, UNIT_W, FACE_Y - 3, UNIT_H);
          return (
            <g key={i} className="rk-unit" data-active={active === i ? "" : undefined} data-locate={located === i ? "" : undefined}>
              <Box paths={paths} className={unit?.lit ? "rk-lit" : undefined} />
              <g transform={cam.plane(INSET + UNIT_W, FACE_Y, zTop, "side")}>
                {[7, 13, 19].map((u) => (
                  <path key={u} className="rk-detail" d={`M${u} 2.6V${UNIT_H - 2.6}`} />
                ))}
              </g>
              <g transform={cam.plane(INSET, FACE_Y, zTop, "front")}>{unit ? <Face unit={unit} index={i} /> : <Blank />}</g>
            </g>
          );
        })}

        <Box paths={boxPaths(cam, 0, D - POST, z0, POST, POST, g.height - z0 - CAP)} />
        <Box paths={boxPaths(cam, W - POST, D - POST, z0, POST, POST, g.height - z0 - CAP)} />
        <Box paths={boxPaths(cam, -1, -1, g.height - CAP, W + 2, D + 2, CAP)} className="rk-cap" />

        {slots.map((unit, i) => {
          if (!unit) return null;
          const zMid = z0 + i * U + U / 2;
          const front = boxPaths(cam, INSET, 3, z0 + i * U + 0.6, UNIT_W, FACE_Y - 3, UNIT_H).front;
          // The leader runs from the label to a pin on the unit's left end.
          const [lx, ly] = cam.P(INSET, FACE_Y, zMid);
          const dim = unit.lamp === "off";
          const on = active === i;
          return (
            <g
              key={i}
              className="rk-note"
              data-dim={dim ? "" : undefined}
              data-active={on ? "" : undefined}
              data-locate={located === i ? "" : undefined}
            >
              <path className="rk-spot" d={front} filter="url(#rk-glow)" />
              <path className="rk-leader" d={`M${f(labelLeft + 8)} ${f(ly)}H${f(lx)}`} />
              <circle className="rk-pin-ring" cx={f(lx)} cy={f(ly)} r={4.6} />
              <circle className="rk-pin" cx={f(lx)} cy={f(ly)} r={1.9} />
              <text className="rk-title" x={labelLeft} y={ly - 3} textAnchor="end">
                <Rich text={clip(unit.title, 24)} />
              </text>
              {unit.detail && (
                <text className="rk-sub" data-warn={unit.warn ? "" : undefined} x={labelLeft} y={ly + 10.5} textAnchor="end">
                  <Rich text={clip(unit.detail, 32)} />
                </text>
              )}
              {/* One hit area for the unit and its label, so pointing at either lights both. */}
              <g
                className="rk-hit"
                role="button"
                tabIndex={0}
                aria-label={`${unit.title}${unit.detail ? `, ${unit.detail}` : ""}. Press to blink its lights.`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                onFocus={() => setActive(i)}
                onBlur={() => setActive((a) => (a === i ? null : a))}
                onClick={() => locate(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    locate(i);
                  }
                }}
              >
                <path d={front} />
                <rect x={labelLeft - 150} y={ly - 15} width={lx - labelLeft + 150} height={30} />
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const BAYS = 4;
const BAY_X = 11;
const BAY_W = 6.4;
const BAY_GAP = 1.6;
const FAN_X = 49;
const BAR_X = 60;
const BAR_W = UNIT_W - BAR_X - 5;
const MID = UNIT_H / 2;

/** What a server shows on its front, in the face's own units. */
function Face({ unit, index }: { unit: RackUnit; index: number }) {
  const off = unit.lamp === "off";
  const live = unit.lamp === "on" || unit.lamp === "busy";
  const fraction = Math.max(0, Math.min(1, unit.fraction ?? 0));
  const speed = unit.lamp === "busy" ? "0.55s" : unit.lamp === "on" ? "1.7s" : "3.4s";
  const blade = `M${FAN_X} ${MID}C${FAN_X + 1} ${MID - 1.6} ${FAN_X + 2.6} ${MID - 3.4} ${FAN_X + 1.2} ${MID - 3.8}C${FAN_X} ${MID - 3.4} ${FAN_X - 0.4} ${MID - 1.6} ${FAN_X} ${MID}Z`;
  return (
    <>
      <rect className="rk-recess" x={1.5} y={1.4} width={UNIT_W - 3} height={UNIT_H - 2.8} rx={1.2} />
      {unit.lit && (
        <>
          <path className="rk-hot-line rk-hot-line-glow" d={`M3 0.7H${UNIT_W - 3}`} />
          <path className="rk-hot-line" d={`M3 0.7H${UNIT_W - 3}`} />
        </>
      )}

      {/* Power lamp: steady while it runs. The glow is a plain soft disc, not a blur filter, so it stays cheap to animate. */}
      {live && <circle className="rk-lamp-glow" cx={6} cy={MID} r={2.8} />}
      <circle className={live ? "rk-lamp rk-hot" : "rk-lamp"} cx={6} cy={MID} r={1.1} />

      {/* Drive bays, each with its own activity light. */}
      {Array.from({ length: BAYS }, (_, k) => {
        const x = BAY_X + k * (BAY_W + BAY_GAP);
        const n = index * 5 + k * 3;
        return (
          <g key={k}>
            <rect className="rk-bay" x={x} y={2.6} width={BAY_W} height={UNIT_H - 5.2} rx={0.6} />
            <path className="rk-detail" d={`M${x + 1.2} ${MID + 0.6}H${x + BAY_W - 1.2}M${x + 1.2} ${MID + 2}H${x + BAY_W - 1.2}`} />
            <circle
              className="rk-act"
              data-on={live ? "" : undefined}
              data-busy={unit.lamp === "busy" ? "" : undefined}
              cx={x + BAY_W - 1.3}
              cy={3.9}
              r={0.55}
              style={{ animationDuration: `${(0.9 + (n % 7) * 0.31).toFixed(2)}s`, animationDelay: `${((n * 37) % 23) * 0.13}s` }}
            />
          </g>
        );
      })}

      {/* Fan: turns while it runs, faster while the drive is read, stopped when switched off. */}
      <circle className="rk-fan-ring" cx={FAN_X} cy={MID} r={4.3} />
      <g className="rk-fan" data-off={off ? "" : undefined} style={{ animationDuration: speed }}>
        {/* Centres the turn on the hub: the blades alone don't. */}
        <circle cx={FAN_X} cy={MID} r={4.3} fill="none" stroke="none" />
        {[0, 72, 144, 216, 288].map((a) => (
          <path key={a} className="rk-blade" d={blade} transform={`rotate(${a} ${FAN_X} ${MID})`} />
        ))}
      </g>
      <circle className="rk-fan-hub" cx={FAN_X} cy={MID} r={0.9} />

      {unit.fraction !== undefined ? (
        <>
          <rect className="rk-track" x={BAR_X} y={MID - 1.4} width={BAR_W} height={2.8} rx={1.4} />
          {fraction > 0 && (
            <rect className={live ? "rk-fill rk-hot" : "rk-fill"} x={BAR_X} y={MID - 1.4} width={BAR_W * fraction} height={2.8} rx={1.4} />
          )}
        </>
      ) : (
        [-2, 0, 2].map((y) => <path key={y} className="rk-detail" d={`M${BAR_X} ${MID + y}H${BAR_X + BAR_W}`} />)
      )}
    </>
  );
}

function Blank() {
  return (
    <>
      <rect className="rk-recess" x={1.5} y={1.4} width={UNIT_W - 3} height={UNIT_H - 2.8} rx={1.2} />
      <path className="rk-detail" d={`M10 ${MID}H${UNIT_W - 10}`} />
    </>
  );
}

/** Numbers, with their unit, in bold. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\d[\d,.]*(?:\s?(?:%|[KMGT]?B))?)/).map((part, i) =>
        i % 2 ? (
          <tspan key={i} className="rk-num">
            {part}
          </tspan>
        ) : (
          part
        )
      )}
    </>
  );
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
