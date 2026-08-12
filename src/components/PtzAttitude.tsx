import type { CSSProperties } from 'react';
import { colors, font } from '../tokens';
import { formatAzimuth, formatElevation, NO_DATA } from '../ptzMetrics';

/**
 * Where the camera is pointing, at a glance.
 *
 * A compass ring for heading and a vertical arc for elevation, both fed from
 * the camera's own reported degrees (see kallon_ptz_daemon's _cgi_position).
 *
 * Why a dial and not just the numbers: the numbers are already in the readout
 * grid, and they answer "what is the heading" precisely. They do NOT answer
 * "which way is it looking" quickly - reading 200 and picturing south-west
 * takes a beat, and while the camera slews the digits are unreadable anyway.
 * A needle is instant and stays legible in motion, which is the whole point
 * while driving the PTZ.
 *
 * NULL IS RENDERED, NOT SUBSTITUTED. If the tower reported no position the
 * needle is hidden and the ring greys out. It never parks at 0 - a needle
 * pointing north is indistinguishable from a needle that has no idea, and
 * the operator would have no way to tell.
 */

interface Props {
  /** Degrees, camera-reported. null = unknown. */
  az: number | null;
  /** Degrees DOWN from horizon, camera-reported. null = unknown. */
  el: number | null;
  /** True while the camera is actually turning. */
  moving?: boolean;
  accent?: string;
}

// The camera's tilt range on this hardware: -20 (above horizon) to +90
// (straight down), measured against the camera's own reported degrees.
const EL_MIN_DOWN = -20;
const EL_MAX_DOWN = 90;

const R = 34;          // compass radius
const CX = 40;
const CY = 40;

function polar(deg: number, r: number): [number, number] {
  // 0deg = north = straight up, increasing clockwise, which is how a compass
  // reads - not the maths convention.
  const rad = ((deg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

export default function PtzAttitude({ az, el, moving = false, accent = colors.accent }: Props) {
  const known = az != null || el != null;
  const dim = colors.textCaption;

  // Elevation arc: map the camera's down-degrees onto a vertical track.
  const elFrac = el == null
    ? null
    : Math.max(0, Math.min(1, (el - EL_MIN_DOWN) / (EL_MAX_DOWN - EL_MIN_DOWN)));

  const label: CSSProperties = {
    fontFamily: font.mono, fontSize: 9, letterSpacing: '.14em',
    color: colors.textCaption,
  };
  const value: CSSProperties = {
    fontFamily: font.mono, fontSize: 13, letterSpacing: '.04em',
    color: known ? colors.textBright : colors.textDisabled,
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 14px', borderRadius: 12,
        background: colors.bgCard, border: `1px solid ${colors.line2}`,
      }}
      title={known
        ? 'Where the camera is pointing, as the camera itself reports it'
        : 'No position reported — not a reading of zero'}
    >
      {/* ---- compass ---- */}
      <svg width="80" height="80" viewBox="0 0 80 80" aria-hidden="true" style={{ flex: '0 0 auto' }}>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke={colors.line2} strokeWidth="1" />
        {/* cardinal ticks */}
        {[0, 90, 180, 270].map((d) => {
          const [x1, y1] = polar(d, R - 1);
          const [x2, y2] = polar(d, R - 6);
          return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke={colors.lineRaised} strokeWidth="1.5" />;
        })}
        {[45, 135, 225, 315].map((d) => {
          const [x1, y1] = polar(d, R - 1);
          const [x2, y2] = polar(d, R - 4);
          return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke={colors.line} strokeWidth="1" />;
        })}
        <text x={CX} y={11} textAnchor="middle" fill={dim}
              style={{ fontFamily: font.mono, fontSize: 8, letterSpacing: '.1em' }}>N</text>

        {az == null ? (
          <text x={CX} y={CY + 4} textAnchor="middle" fill={colors.textDisabled}
                style={{ fontFamily: font.mono, fontSize: 11 }}>{NO_DATA}</text>
        ) : (
          <g>
            {/* the needle: filled toward the heading, stub the other way, so
                direction is unambiguous at a glance */}
            <line
              x1={polar(az + 180, 9)[0]} y1={polar(az + 180, 9)[1]}
              x2={polar(az, R - 8)[0]} y2={polar(az, R - 8)[1]}
              stroke={accent} strokeWidth="2" strokeLinecap="round"
            />
            <circle cx={polar(az, R - 8)[0]} cy={polar(az, R - 8)[1]} r="2.5" fill={accent} />
            <circle cx={CX} cy={CY} r="2" fill={colors.bgCard} stroke={colors.lineRaised} strokeWidth="1" />
            {moving && (
              <circle cx={CX} cy={CY} r={R} fill="none" stroke={accent} strokeWidth="1" opacity="0.45">
                <animate attributeName="opacity" values="0.45;0.08;0.45" dur="1.4s" repeatCount="indefinite" />
              </circle>
            )}
          </g>
        )}
      </svg>

      {/* ---- elevation arc ---- */}
      <svg width="26" height="80" viewBox="0 0 26 80" aria-hidden="true" style={{ flex: '0 0 auto' }}>
        <line x1="13" y1="8" x2="13" y2="72" stroke={colors.line2} strokeWidth="1" />
        {/* horizon reference */}
        {(() => {
          const hy = 8 + ((0 - EL_MIN_DOWN) / (EL_MAX_DOWN - EL_MIN_DOWN)) * 64;
          return <line x1="6" y1={hy} x2="20" y2={hy} stroke={colors.lineRaised} strokeWidth="1" />;
        })()}
        {elFrac == null ? (
          <text x="13" y="44" textAnchor="middle" fill={colors.textDisabled}
                style={{ fontFamily: font.mono, fontSize: 10 }}>{NO_DATA}</text>
        ) : (
          <g>
            <line x1="5" y1={8 + elFrac * 64} x2="21" y2={8 + elFrac * 64}
                  stroke={accent} strokeWidth="2" strokeLinecap="round" />
            <circle cx="13" cy={8 + elFrac * 64} r="2.5" fill={accent} />
          </g>
        )}
      </svg>

      {/* ---- numbers ---- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <div>
          <div style={label}>HEADING</div>
          <div style={value}>{formatAzimuth(az)}</div>
        </div>
        <div>
          <div style={label}>ELEVATION</div>
          <div style={value}>{formatElevation(el)}</div>
        </div>
      </div>
    </div>
  );
}
