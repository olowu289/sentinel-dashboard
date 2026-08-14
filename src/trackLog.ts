/**
 * Live track events — what the tracker is doing, as it does it.
 *
 * These arrive on the SAME SSE stream as alerts (gateway `/api/events`), because
 * an alert is a track event that crossed a threshold rather than a separate
 * thing. Two streams would eventually disagree about what happened, and then the
 * question becomes which one to believe. Each message carries `type` so the two
 * shapes never have to be told apart by guessing at fields.
 *
 * The log is TOWER-WIDE: every camera writes into one list, which is why each
 * row names its camera. An operator watching the wall should not have to pick a
 * camera before they can see what the tower is doing.
 */

/** Event kinds, in the order an engagement actually produces them. */
export type TrackEventKind =
  | 'CUE'       // an external bearing arrived (RF)
  | 'SLEW'      // driving toward it
  | 'ACQ'       // acquired
  | 'TRK'       // still on it
  | 'LOST'      // gone
  | 'HANDOFF'   // leaving this camera's sector
  | 'LIMIT'     // the mount cannot follow further
  | 'HOME'      // returning to rest
  | 'ALERT'     // crossed the alert threshold
  | 'DISARM';   // tracking switched off mid-move

export type TrackSeverity = 'info' | 'warning' | 'critical';

export interface TrackEvent {
  id: number;
  kind: TrackEventKind;
  severity: TrackSeverity;
  /** null for a source that is not a camera — an RF cue arrives before any
   *  camera owns it, and that reads as its own row. */
  camera: number | null;
  detail: string;
  /** Degrees TRUE, not the camera's own pan reading. null when that camera has
   *  no north offset yet: a dash is honest, a number derived from an unknown
   *  offset would look authoritative and be wrong. */
  bearingDeg: number | null;
  /** Up-positive, the way an operator reads it. */
  elevationDeg: number | null;
  ts: string;
}

const KINDS: TrackEventKind[] = [
  'CUE', 'SLEW', 'ACQ', 'TRK', 'LOST', 'HANDOFF', 'LIMIT', 'HOME', 'ALERT', 'DISARM',
];

/**
 * How many rows to keep. Enough to scroll back through an engagement, small
 * enough that a tower left running overnight cannot grow the tab's memory
 * without bound.
 */
export const TRACK_LOG_MAX = 300;

let nextId = 1;

/** Parse one SSE message. Returns null when it isn't a track event. */
export function parseTrackEvent(raw: unknown): TrackEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'track') return null;

  const kind = KINDS.includes(r.event as TrackEventKind) ? (r.event as TrackEventKind) : 'TRK';
  const sev = r.severity === 'warning' || r.severity === 'critical' ? r.severity : 'info';
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const cam = typeof r.camera === 'number' && Number.isFinite(r.camera) ? r.camera : null;

  return {
    id: nextId++,
    kind,
    severity: sev,
    camera: cam,
    detail: typeof r.detail === 'string' ? r.detail : '',
    bearingDeg: num(r.bearing_deg),
    elevationDeg: num(r.elevation_deg),
    ts: typeof r.ts === 'string' ? r.ts : new Date().toISOString(),
  };
}

/** HH:MM:SS in local time — an operator reads the clock on the wall, not UTC. */
export function trackTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Bearings are always three digits so the column stays a column: 007, 046, 181. */
export function formatBearing(deg: number | null): string {
  if (deg == null) return '—';
  return `${String(Math.round(((deg % 360) + 360) % 360)).padStart(3, '0')}°`;
}

/** Signed, because "is it above or below me" is the question being asked. */
export function formatElevation(deg: number | null): string {
  if (deg == null) return '—';
  const r = Math.round(deg);
  return `${r < 0 ? '−' : '+'}${String(Math.abs(r)).padStart(2, '0')}°`;
}

/** cam1 / cam2 / rf — identity, deliberately not severity. */
export function cameraClass(camera: number | null): string {
  if (camera == null) return 'rf';
  return camera === 1 ? 'c1' : camera === 2 ? 'c2' : 'cn';
}

export function cameraLabel(camera: number | null): string {
  return camera == null ? 'RF' : `C${camera}`;
}
