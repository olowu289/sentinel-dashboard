/** Formatting for the operator-facing PTZ readout.
 *
 * These are FORMATTERS ONLY. There is deliberately no conversion here any
 * more: the tower reports real degrees and a real zoom ratio (the camera's
 * own numbers - see kallon_ptz_daemon.py's _cgi_position), so the dashboard
 * has nothing left to compute.
 *
 * What used to live here was an onvifToMetrics() that turned normalized
 * ONVIF values into degrees by guessing - pan x180, tilt x30 (and x45 in a
 * second copy elsewhere), zoom mapped to a made-up 8x range. Measured against
 * the camera, elevation was out by 2-3x and zoom by the difference between an
 * assumed 8x lens and a real 25x one. It is gone rather than corrected: the
 * camera knows these numbers and there is no reason to model them here.
 */

/** null = the tower reported no position. Renders as an explicit dash so a
 * missing reading can never be mistaken for a real one. */
export const NO_DATA = '—';

export function formatAzimuth(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return NO_DATA;
  const wrapped = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(wrapped).padStart(3, '0')}°`;
}

/** The camera reports tilt as degrees DOWN from the horizon (90 = straight
 * down, 0 = level, negative = above horizon). Operators read elevation as
 * up-positive, so the sign is flipped for display: +12° means twelve degrees
 * ABOVE the horizon. */
export function formatElevation(degDown: number | null | undefined): string {
  if (degDown == null || !Number.isFinite(degDown)) return NO_DATA;
  const up = -Math.round(degDown);
  return `${up >= 0 ? '+' : '-'}${String(Math.abs(up)).padStart(2, '0')}°`;
}

export function formatZoom(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return NO_DATA;
  return `${ratio.toFixed(1)}×`;
}
