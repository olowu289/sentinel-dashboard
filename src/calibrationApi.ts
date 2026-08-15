import { LOCAL_CONTROL_HOST } from './videoSourceMode';

/**
 * Calibration, from the console.
 *
 * Direct calls to the tower's own gateway, same as localPtzApi.ts and
 * aiTrackingApi.ts and for the same reason: this is tower-local state with no
 * remote route. No API key — gateway.py has no authentication of any kind.
 *
 * What the tower will and will not do is decided on the tower, not here: the
 * step must be one of a fixed whitelist and every argument is re-validated
 * server-side. Nothing in this file is a security boundary, and it should not
 * be treated as one — it is a convenience layer over a fenced endpoint.
 */

export interface CalibrationStep {
  id: string;
  label: string;
  /** True if running it drives the mount off its current aim. Worth saying out
   *  loud before an operator presses it on a live tower. */
  moves_camera: boolean;
}

export interface CameraCalibration {
  camera: number;
  has_bundle: boolean;
  /** Everything the tracker needs is measured. Not the same as "fully
   *  calibrated" — a camera can steer without a north offset, it just cannot
   *  report a real-world bearing. */
  can_steer: boolean;
  missing_required: string[];
  missing_optional: string[];
  north_offset_deg: number | null;
  north_method: string | null;
  jac_at_focal_mm: number | null;
  pan_sd_pct: number | null;
  tilt_sd_pct: number | null;
  updated: Record<string, { at?: string; by?: string; host?: string }>;
}

export interface CalibrationStatus {
  tower: string;
  cameras: CameraCalibration[];
  steps: CalibrationStep[];
}

export interface CalibrationJob {
  running: boolean;
  step?: string;
  camera?: number;
  label?: string;
  output?: string;
  exit_code?: number | null;
  started_utc?: string;
  finished_utc?: string;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://${LOCAL_CONTROL_HOST}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const e = new Error('tower unreachable') as Error & { code?: string };
    e.code = 'local_unreachable';
    e.cause = err;
    throw e;
  }
  const parsed: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const p = parsed as { error?: { code?: string; message?: string } };
    const e = new Error(p.error?.message || `request failed (${res.status})`) as Error & { code?: string };
    e.code = p.error?.code || String(res.status);
    throw e;
  }
  return parsed as T;
}

export function fetchCalibrationStatus(): Promise<CalibrationStatus> {
  return req<CalibrationStatus>('GET', '/api/calibration/status');
}

export function fetchCalibrationJob(): Promise<CalibrationJob> {
  return req<CalibrationJob>('GET', '/api/calibration/job');
}

/**
 * Start one step. Resolves as soon as the tower has ACCEPTED it, not when it
 * finishes — these run for minutes and hold the camera while they do. Poll
 * fetchCalibrationJob for progress.
 */
export function runCalibrationStep(
  camera: number, step: string, args: Record<string, unknown> = {},
): Promise<{ started: boolean }> {
  return req('POST', '/api/calibration/run', { camera, step, args });
}

/** Steps that need a decision from the operator rather than just a start. */
export const STEP_NEEDS_INPUT: Record<string, 'bearing' | 'home' | 'sector'> = {
  '05': 'bearing',
  '06': 'home',
  '07': 'sector',
};

/** Why each step exists, in the words an operator needs rather than the
 *  file's own. Shown beside the button so pressing one is an informed act. */
export const STEP_HELP: Record<string, string> = {
  '01': 'Reads the camera’s identity and frame size. Safe, quick, does not move anything.',
  '02': 'Drives the mount to each end of its travel to find the real limits. Assumed limits are how a tracker ends up chasing a position the camera cannot reach.',
  '03': 'Steps through the zoom range measuring how sensitivity changes. Without it, tracking is only correct near one zoom setting.',
  '04': 'Measures how much the picture moves for a given pan and tilt. Aim at something distant with hard edges, all at a similar distance — open sky or a blank wall gives it nothing to measure.',
  '05': 'Turns the camera’s own pan reading into a true compass bearing. Point the camera at a landmark first, then give its true bearing from the tower.',
  '06': 'Stores where the camera returns to when idle. Aim it where you want home, then use “use current aim”.',
  '07': 'Assigns the arc of sky this camera owns, so two cameras can divide the sky and hand over between them.',
};
