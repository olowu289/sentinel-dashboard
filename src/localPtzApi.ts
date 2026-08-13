import type { PtzMoveBody, PtzStopBody, PtzStatusResult } from '@sentinel/sdk';
import { LOCAL_CONTROL_HOST } from './videoSourceMode';

/**
 * Direct calls to the Jetson's own gateway (dashboard "local video mode"
 * extended to PTZ/control — see videoSourceMode.ts) instead of the
 * platform/hub path. Mirrors ptzApi.ts's shape, but:
 *   - no device_id in the path — gateway.py's routes are camera-scoped
 *     only (/api/ptz/move, not /v1/towers/{id}/ptz/move); there's only
 *     ever one tower on the other end of a raw LAN connection anyway.
 *   - no API key sent: gateway.py has NO authentication of any kind
 *     (checked every route — see 90-firewall.sh's AUTH NOTE), so sending
 *     one would do nothing and would misleadingly imply a security
 *     property that doesn't exist.
 * Same request/response body shapes as the platform path — the platform
 * proxy just forwards these verbatim to the tower's own gateway (see
 * infra/enrollment-api/app/platform.py's _proxy) — so the SDK's
 * PtzMoveBody/PtzStopBody/PtzStatusResult types are reused directly rather
 * than duplicated.
 */

async function localRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    // Network-level failure (not on the island, gateway down, etc.) — the
    // one case callers most need to distinguish, see DashboardConsole's
    // "local control unreachable" toast.
    const wrapped = new Error('local control unreachable') as Error & { code?: string };
    wrapped.code = 'local_unreachable';
    wrapped.cause = err;
    throw wrapped;
  }
  const resBody: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errObj = (resBody as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = typeof errObj?.code === 'string' ? errObj.code : undefined;
    const msg =
      (typeof errObj?.message === 'string' && errObj.message)
      || (resBody as { detail?: unknown } | undefined)?.detail
      || res.statusText;
    const err = new Error(typeof msg === 'string' && msg ? msg : `HTTP ${res.status}`) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  }
  return resBody as T;
}

/**
 * The SDK's PtzMoveBody plus "jog" — a hold-to-move that the tower drives over
 * the camera's own CGI (~63ms to start against ONVIF's ~1348ms), falling back
 * to ONVIF itself for cameras that don't speak it.
 *
 * Widened here rather than in the SDK on purpose: the SDK is pinned and shared
 * with Sentinel, whose platform path has no such mode. This is a tower-direct
 * capability, so it belongs on the tower-direct client.
 */
export type LocalPtzMoveBody =
  | PtzMoveBody
  | (Omit<PtzMoveBody, 'mode'> & { mode: 'jog' });

export function localPtzMove(body: LocalPtzMoveBody): Promise<Record<string, unknown>> {
  return localRequest('POST', '/api/ptz/move', body);
}

export function localPtzStop(body: PtzStopBody = {}): Promise<Record<string, unknown>> {
  return localRequest('POST', '/api/ptz/stop', body);
}

export function localPtzStatus(camera = 1): Promise<PtzStatusResult> {
  return localRequest('GET', `/api/ptz/status?camera=${camera}`);
}

/** Refreshes the daemon's 4s hold-to-move safety timeout — same purpose as
 * ptzApi.ts's platform-path ptzKeepalive, just local. Best-effort by the
 * same convention: a dropped keepalive isn't fatal on its own. */
export function localPtzKeepalive(camera: number): Promise<Record<string, unknown>> {
  return localRequest('POST', '/api/ptz/keepalive', { camera });
}
