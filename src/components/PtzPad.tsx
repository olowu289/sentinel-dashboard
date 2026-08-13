import { useState, type PointerEvent } from 'react';
import type { CSSProperties } from 'react';
import { font } from '../tokens';

export type PanDir =
  | 'up' | 'down' | 'left' | 'right'
  | 'upleft' | 'upright' | 'downleft' | 'downright';

/** Unit pan/tilt components per direction. Diagonals are scaled by 1/sqrt(2)
 * so a corner press travels at the SAME speed as an edge press — at full
 * value on both axes a diagonal would be 1.41x faster, which reads as the pad
 * being twitchy in the corners. */
const D = Math.SQRT1_2;
export const PAN_VECTOR: Record<PanDir, { pan: number; tilt: number }> = {
  up:        { pan:  0, tilt:  1 },
  down:      { pan:  0, tilt: -1 },
  left:      { pan: -1, tilt:  0 },
  right:     { pan:  1, tilt:  0 },
  upleft:    { pan: -D, tilt:  D },
  upright:   { pan:  D, tilt:  D },
  downleft:  { pan: -D, tilt: -D },
  downright: { pan:  D, tilt: -D },
};

interface Props {
  accent: string;
  size?: string;
  /** Pointer down — begin hold-to-jog */
  onPanStart: (dir: PanDir) => void;
  /** Pointer up / leave — end jog or complete tap */
  onPanEnd: () => void;
  onRecenter: () => void;
  /** True while a PTZ command for this camera is in flight — pad + home go inert. */
  disabled?: boolean;
}

/* ---- geometry ------------------------------------------------------------
 * One ring of eight 45-degree wedges around a hub. Drawn as SVG rather than
 * positioned boxes because the wedges have to MEET: adjacent sectors share an
 * edge exactly, so there is no dead gap between "up" and "upright" for a press
 * to fall into. The old pad was eight rectangles on a circle with real gaps
 * between them, and a press landing in one did nothing at all.
 *
 * Angles are SVG convention: 0 is +x (right) and they increase clockwise, so
 * "up" is -90.
 */
const VB = 100;              // viewBox units
const CX = 50, CY = 50;
const R_OUT = 49;            // outer edge of the ring
const R_IN = 25;             // inner edge — the hub sits exactly in this hole
const SWEEP = 45;            // degrees per wedge

/** Order matters only for rendering; each carries its own centre angle. */
const WEDGES: { dir: PanDir; at: number; label: string }[] = [
  { dir: 'up',        at: -90, label: 'Tilt up' },
  { dir: 'upright',   at: -45, label: 'Pan right and tilt up' },
  { dir: 'right',     at:   0, label: 'Pan right' },
  { dir: 'downright', at:  45, label: 'Pan right and tilt down' },
  { dir: 'down',      at:  90, label: 'Tilt down' },
  { dir: 'downleft',  at: 135, label: 'Pan left and tilt down' },
  { dir: 'left',      at: 180, label: 'Pan left' },
  { dir: 'upleft',    at: 225, label: 'Pan left and tilt up' },
];

const pt = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)] as const;
};

/** Annulus sector centred on `at`, spanning SWEEP degrees. */
function wedgePath(at: number): string {
  const a0 = at - SWEEP / 2;
  const a1 = at + SWEEP / 2;
  const [x0o, y0o] = pt(a0, R_OUT);
  const [x1o, y1o] = pt(a1, R_OUT);
  const [x1i, y1i] = pt(a1, R_IN);
  const [x0i, y0i] = pt(a0, R_IN);
  return [
    `M ${x0i} ${y0i}`,
    `L ${x0o} ${y0o}`,
    `A ${R_OUT} ${R_OUT} 0 0 1 ${x1o} ${y1o}`,
    `L ${x1i} ${y1i}`,
    `A ${R_IN} ${R_IN} 0 0 0 ${x0i} ${y0i}`,
    'Z',
  ].join(' ');
}

/** Outward-pointing chevron sitting on the wedge's centre line.
 * Kept small on purpose — it marks the direction, it is not the target. The
 * whole wedge takes the press, so a bigger glyph would only crowd the ring. */
function arrowPath(at: number): string {
  const mid = (R_IN + R_OUT) / 2;
  const [tx, ty] = pt(at, mid + 3.4);         // tip
  const [lx, ly] = pt(at - 8, mid - 2.2);     // back-left
  const [rx, ry] = pt(at + 8, mid - 2.2);     // back-right
  return `M ${tx} ${ty} L ${lx} ${ly} L ${rx} ${ry} Z`;
}

/**
 * Eight-way directional pad.
 *
 * Tap = a short press; press-and-hold = an unbounded jog at the speed set by
 * the slider, refreshed by keepalives and stopped on release. Both go out as
 * one "jog" command — see DashboardConsole's sendMove.
 *
 * Diagonals exist because a camera moves both axes at once and forcing an
 * operator to chase a target in two separate presses is slower and less
 * accurate than letting them push toward it directly.
 */
export default function PtzPad({ accent, size = '176px', onPanStart, onPanEnd, onRecenter, disabled = false }: Props) {
  const accentVar = { '--accent': accent } as CSSProperties;
  const [active, setActive] = useState<PanDir | null>(null);

  const bind = (dir: PanDir) => ({
    onPointerDown: (e: PointerEvent<SVGPathElement>) => {
      if (disabled) return;
      e.preventDefault();
      // Capture binds the whole gesture to the wedge it started on. Without it
      // a finger drifting a few pixels across a wedge boundary would leave the
      // element mid-press, and the ring's segments are narrow enough that this
      // happens constantly.
      (e.currentTarget as unknown as Element).setPointerCapture(e.pointerId);
      setActive(dir);
      onPanStart(dir);
    },
    onPointerUp: (e: PointerEvent<SVGPathElement>) => {
      e.preventDefault();
      setActive(null);
      onPanEnd();
    },
    onPointerCancel: () => {
      setActive(null);
      onPanEnd();
    },
    // NOT wired to onPanEnd. Releasing the pointer implicitly releases capture,
    // so lostpointercapture fires immediately after every pointerup — wiring it
    // here called onPanEnd twice for one release. pointerup and pointercancel
    // between them already cover every way a press can end.
  });

  /** The hub fills the ring's hole exactly, so the two are in contact. */
  const hubPct = `${(R_IN * 2 * 100) / VB}%`;

  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none', touchAction: 'none' }}>
      <svg
        viewBox={`0 0 ${VB} ${VB}`}
        width="100%"
        height="100%"
        style={{ ...accentVar, display: 'block', overflow: 'visible' }}
        aria-label="Camera direction pad"
      >
        {/* Seat the ring on a dark disc so the dividers read as cut lines
            rather than as eight separate objects floating apart. */}
        <circle cx={CX} cy={CY} r={R_OUT} className="pad-ring-bed" />
        <g className={`pad-ring${disabled ? ' disabled' : ''}`}>
          {WEDGES.map(({ dir, at, label }) => (
            <g key={dir} className={`pad-wedge${active === dir ? ' active' : ''}`}>
              <path
                d={wedgePath(at)}
                className="pad-wedge-hit"
                role="button"
                aria-label={label}
                aria-pressed={active === dir}
                {...bind(dir)}
              />
              <path d={arrowPath(at)} className="pad-wedge-arrow" />
            </g>
          ))}
        </g>
        <circle cx={CX} cy={CY} r={R_OUT} className="pad-ring-edge" />
      </svg>

      <button
        type="button"
        className="pad-center"
        onClick={onRecenter}
        disabled={disabled}
        title="Recenter camera"
        aria-label="Recenter camera"
        style={{ ...accentVar, fontFamily: font.display, width: hubPct, height: hubPct }}
      >
        <span style={{ fontSize: 18, lineHeight: 1 }}>⌖</span>
        <span style={{ fontWeight: 700, fontSize: 9, letterSpacing: '.1em', lineHeight: 1 }}>HOME</span>
      </button>
    </div>
  );
}
