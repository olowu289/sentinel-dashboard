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

/**
 * Eight-way directional pad.
 *
 * Tap = one short bounded pulse; press-and-hold = an unbounded jog at the
 * speed set by the slider, refreshed by keepalives and stopped on release.
 * Both are ONVIF ContinuousMove — see DashboardConsole's sendMove.
 *
 * Diagonals exist because a camera moves both axes at once and forcing an
 * operator to chase a target in two separate presses is slower and less
 * accurate than letting them push toward it directly.
 */
export default function PtzPad({ accent, size = '176px', onPanStart, onPanEnd, onRecenter, disabled = false }: Props) {
  const accentVar = { '--accent': accent } as CSSProperties;
  const [active, setActive] = useState<PanDir | null>(null);

  const bind = (dir: PanDir) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setActive(dir);
      onPanStart(dir);
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      setActive(null);
      onPanEnd();
    },
    onPointerCancel: () => {
      setActive(null);
      onPanEnd();
    },
    onLostPointerCapture: () => {
      setActive(null);
      onPanEnd();
    },
    disabled,
    className: `pad-btn pad-${dir}${active === dir ? ' active' : ''}`,
    'aria-pressed': active === dir,
  });

  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none', touchAction: 'none' }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1px solid #2b343d', background: 'radial-gradient(circle at 50% 42%,#161d23,#0f151a)', boxShadow: 'inset 0 2px 10px rgba(0,0,0,.5)' }} />
      <div style={{ position: 'absolute', inset: 14, borderRadius: '50%', border: '1px dashed #29323b', pointerEvents: 'none' }} />

      <button type="button" {...bind('up')} aria-label="Tilt up">▲</button>
      <button type="button" {...bind('down')} aria-label="Tilt down">▼</button>
      <button type="button" {...bind('left')} aria-label="Pan left">◀</button>
      <button type="button" {...bind('right')} aria-label="Pan right">▶</button>

      <button type="button" {...bind('upleft')} aria-label="Pan left and tilt up">◤</button>
      <button type="button" {...bind('upright')} aria-label="Pan right and tilt up">◥</button>
      <button type="button" {...bind('downleft')} aria-label="Pan left and tilt down">◣</button>
      <button type="button" {...bind('downright')} aria-label="Pan right and tilt down">◢</button>

      <button
        type="button"
        className="pad-center"
        onClick={onRecenter}
        disabled={disabled}
        title="Recenter camera"
        aria-label="Recenter camera"
        style={{ ...accentVar, fontFamily: font.display }}
      >
        <span style={{ fontSize: 20, lineHeight: 1 }}>⌖</span>
        <span style={{ fontWeight: 700, fontSize: 9, letterSpacing: '.1em', lineHeight: 1 }}>HOME</span>
      </button>
    </div>
  );
}
