import type { Session } from './session';

/**
 * Small dashboard-local module for platform PTZ routes the SDK doesn't cover
 * yet (same reasoning as webrtcApi.ts) — rather than a cross-repo SDK release
 * for one or two calls.
 */
async function ptzPost(
  session: Session,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (session.apiKey) headers['X-Kallon-Api-Key'] = session.apiKey;
  if (session.baseUrl.includes('ngrok')) headers['ngrok-skip-browser-warning'] = '1';
  const url = `${session.baseUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof resBody?.error?.code === 'string' ? resBody.error.code : undefined;
    const msg = resBody?.error?.message ?? resBody?.detail ?? res.statusText;
    const err = new Error(msg || `HTTP ${res.status}`) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  }
  return resBody as Record<string, unknown>;
}

export function ptzSetHome(session: Session, deviceId: string, camera: number): Promise<Record<string, unknown>> {
  return ptzPost(session, `/v1/towers/${encodeURIComponent(deviceId)}/ptz/set-home`, { camera });
}

/**
 * Refreshes the daemon's 4s hold-to-move safety timeout while a continuous
 * move is deliberately still held. Not a movement command — send roughly
 * every 2s while held; best-effort (a dropped keepalive isn't fatal, it just
 * means the safety timeout may fire a little early on that camera).
 */
export function ptzKeepalive(session: Session, deviceId: string, camera: number): Promise<Record<string, unknown>> {
  return ptzPost(session, `/v1/towers/${encodeURIComponent(deviceId)}/ptz/keepalive`, { camera });
}
