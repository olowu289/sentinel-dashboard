import type {
  PtzMoveBody, PtzStopBody, PtzStatusResult, RecordingStatus, StreamsResponse,
} from '@sentinel/sdk';
import type { StatusResponse } from './apiTypes';
import { LOCAL_CONTROL_HOST } from './videoSourceMode';

/**
 * The tower, over the cable. This is the ONLY way Bayanan talks to anything.
 *
 * There is no platform, no hub, no Railway, and no internet path. The browser
 * is on the same segment as the tower and speaks directly to its gateway.
 * That is the entire point of this product line: a hop to a machine on the
 * same switch answers in single-digit milliseconds, where the platform round
 * trip was hundreds. Everything that made the platform worth having -
 * multi-tower fleets, remote access, accounts - is exactly what Bayanan does
 * not want.
 *
 * The method surface deliberately mirrors the SDK's SentinelClient so the
 * views did not all have to be rewritten at once. Two differences worth
 * knowing:
 *
 *   - `deviceId` is accepted and IGNORED. On a cable there is one tower - the
 *     one you are plugged into - so there is nothing to address. The
 *     parameter survives only so call sites could be migrated gradually; it
 *     should disappear as they are cleaned up.
 *   - There is NO API key and NO session. The gateway has no authentication
 *     of any kind (its own words: "no authentication, bench/lab only" - the
 *     firewall and the physical segment are the whole trust boundary).
 *     Sending a key would imply a security property that does not exist.
 *     This is a demo-stage decision, taken knowingly; it has to be revisited
 *     before this is a product in the field.
 */

export class TowerUnreachable extends Error {
  readonly code = 'tower_unreachable';
  constructor(cause?: unknown) {
    super('tower unreachable — not on the camera segment, or the gateway is down');
    this.cause = cause;
  }
}

const base = () => `http://${LOCAL_CONTROL_HOST}`;

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network-level failure. Distinguished from an HTTP error because it is
    // the one an operator can act on: it means "you are not on the segment".
    throw new TowerUnreachable(err);
  }
  const parsed: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (parsed as { error?: { code?: unknown; message?: unknown } })?.error;
    const err = new Error(
      (typeof e?.message === 'string' && e.message) || res.statusText || `HTTP ${res.status}`,
    ) as Error & { code?: string };
    if (typeof e?.code === 'string') err.code = e.code;
    throw err;
  }
  return parsed as T;
}

/** One optic. The tower reports which kind it is rather than leaving the UI
 * to infer it from the path name. */
export interface TowerLens {
  path: string;
  label?: string | null;
  lens?: 'ptz' | 'fixed';
  ptz_capable?: boolean;
  hls_url?: string | null;
  mjpeg_url?: string | null;
}

/** One physical camera. These domes carry TWO optics: a PTZ one (the entry
 * itself) and a fixed wide one (`fixed`), on separate video channels. */
export interface TowerCamera extends TowerLens {
  camera: number;
  fixed?: TowerLens | null;
}

export interface TowerConfig {
  device_id?: string;
  label?: string;
  cameras: TowerCamera[];
}

export const towerClient = {
  /** The tower's own identity and camera list. Replaces the platform's
   * fleet/tower lookup entirely - on a cable there is nothing to choose. */
  config: () => req<TowerConfig>('GET', '/api/config'),

  ptzMove: (_deviceId: string, body: PtzMoveBody) =>
    req<Record<string, unknown>>('POST', '/api/ptz/move', body),

  ptzStop: (_deviceId: string, body: PtzStopBody = {}) =>
    req<Record<string, unknown>>('POST', '/api/ptz/stop', body),

  ptzStatus: (_deviceId: string, camera = 1) =>
    req<PtzStatusResult>('GET', `/api/ptz/status?camera=${camera}`),

  ptzKeepalive: (_deviceId: string, camera = 1) =>
    req<Record<string, unknown>>('POST', '/api/ptz/keepalive', { camera }),

  towerStreams: (_deviceId?: string) => req<StreamsResponse>('GET', '/api/streams'),

  towerStatus: (_deviceId?: string) => req<StatusResponse>('GET', '/api/status'),

  getRecording: (_deviceId?: string) => req<RecordingStatus>('GET', '/api/recording'),

  setRecording: (_deviceId: string, enabled: boolean) =>
    req<RecordingStatus>('PUT', '/api/recording', { enabled }),

  /** Live alert stream. The gateway pushes alerts as they happen and keeps no
   * backlog, so unlike the platform there is no history to page through -
   * what you see starts when you connect. */
  eventsUrl: () => `${base()}/api/events`,

  snapshotUrl: (camera = 1) => `${base()}/api/snapshot/cam${camera}`,
};

export type TowerClient = typeof towerClient;
