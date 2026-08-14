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
  /** The TARGET's bearing, degrees TRUE — not the camera's pan reading, and
   *  not the camera's aim either. Falls back to the camera's aim for a row with
   *  no target (SLEW, HOME); both are "where this row's subject is", the
   *  target's being the more precise. null when that camera has no north offset
   *  yet: a dash is honest, a number from an unknown offset would look
   *  authoritative and be wrong. */
  bearingDeg: number | null;
  /** Up-positive, the way an operator reads it. */
  elevationDeg: number | null;
  /** ESTIMATED distance in metres, or null. The tower cannot MEASURE range —
   *  see infra/tower/geo.py. Always read together with rangeSource. */
  rangeM: number | null;
  /** How rangeM was obtained. 'assumed_size' rests on a guess at the drone's
   *  physical size and can be out by ~6x; 'cross_bearing' and 'ground_geometry'
   *  are real measurements. null means no range. Rendered as a leading "~" for
   *  anything unmeasured, so an estimate can never be read as a fix. */
  rangeSource: RangeSource | null;
  /** Degrees per second of bearing change — the one kinematic quantity a single
   *  camera can measure without a range. Negative is anticlockwise (bearing
   *  falling). null while the mount is slewing or the track is new. */
  bearingRateDegS: number | null;
  ts: string;
}

/** Ordered worst to best. Only the last two are measurements. */
export type RangeSource = 'assumed_size' | 'ground_geometry' | 'remote_id' | 'cross_bearing';

const MEASURED_SOURCES: RangeSource[] = ['ground_geometry', 'cross_bearing'];

export function isMeasuredRange(src: RangeSource | null): boolean {
  return src != null && MEASURED_SOURCES.includes(src);
}

const RANGE_SOURCES: RangeSource[] = [
  'assumed_size', 'ground_geometry', 'remote_id', 'cross_bearing',
];

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
    rangeM: num(r.range_m),
    rangeSource: RANGE_SOURCES.includes(r.range_source as RangeSource)
      ? (r.range_source as RangeSource)
      : null,
    bearingRateDegS: num(r.bearing_rate_deg_s),
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

/**
 * Range, carrying its own honesty. An unmeasured range gets a leading "~":
 * the tower cannot measure distance, and a bare "412m" in a log is exactly the
 * number somebody reads out over a radio.
 */
export function formatRange(m: number | null, src: RangeSource | null): string {
  if (m == null) return '—';
  const tilde = isMeasuredRange(src) ? '' : '~';
  if (m >= 10000) return `${tilde}${Math.round(m / 1000)}km`;
  if (m >= 1000) return `${tilde}${(m / 1000).toFixed(1)}km`;
  return `${tilde}${Math.round(m)}m`;
}

/** Why a range should or should not be trusted — the row's tooltip. */
export function rangeTitle(m: number | null, src: RangeSource | null): string {
  if (m == null) return 'No range — the tower cannot measure distance from one camera';
  switch (src) {
    case 'cross_bearing':
      return `${Math.round(m)} m, measured by two towers crossing bearings — assumes nothing about the target`;
    case 'ground_geometry':
      return `${Math.round(m)} m, measured from mount height and look-down angle — valid for targets on the ground`;
    case 'remote_id':
      return `${Math.round(m)} m, from the drone's own broadcast altitude`;
    case 'assumed_size':
      return `ESTIMATE ~${Math.round(m)} m, from apparent size and an assumed drone size. `
        + `Could be anywhere from ${Math.round(m / 6)} to ${Math.round(m * 6)} m — the scale is a guess, not a measurement.`;
    default:
      return `${Math.round(m)} m, source unrecorded — treat as an estimate`;
  }
}

/**
 * Bearing rate. Signed, because which way it is going is the point, and the
 * sign is what distinguishes a target crossing left from one crossing right.
 */
export function formatRate(degS: number | null): string {
  if (degS == null) return '—';
  const r = Math.abs(degS) >= 10 ? degS.toFixed(0) : degS.toFixed(1);
  return `${degS > 0 ? '+' : degS < 0 ? '−' : ''}${r.replace('-', '')}`;
}

/** What a rate MEANS, which is the useful part and needs no range at all. */
export function rateTitle(degS: number | null): string {
  if (degS == null) return 'No bearing rate — new track, or the camera is slewing';
  const a = Math.abs(degS);
  if (a < 0.3) {
    return `${degS.toFixed(1)} deg/s — bearing almost steady. If it is also getting closer, `
      + `that is collision geometry: something heading straight at the tower.`;
  }
  return `${degS.toFixed(1)} deg/s — crossing ${degS > 0 ? 'clockwise (bearing rising)' : 'anticlockwise (bearing falling)'}. `
    + `Speed in m/s needs a range, which the tower cannot measure.`;
}
