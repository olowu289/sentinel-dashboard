import type { Session } from './session';

/**
 * set_home isn't in @sentinel/sdk (same reasoning as webrtcApi.ts: a small,
 * dashboard-local module for a platform route the SDK doesn't cover yet,
 * rather than a cross-repo SDK release for one new call).
 */
export async function ptzSetHome(
  session: Session,
  deviceId: string,
  camera: number,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (session.apiKey) headers['X-Kallon-Api-Key'] = session.apiKey;
  if (session.baseUrl.includes('ngrok')) headers['ngrok-skip-browser-warning'] = '1';
  const url = `${session.baseUrl.replace(/\/$/, '')}/v1/towers/${encodeURIComponent(deviceId)}/ptz/set-home`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ camera }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
    const msg = body?.error?.message ?? body?.detail ?? res.statusText;
    const err = new Error(msg || `HTTP ${res.status}`) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  }
  return body as Record<string, unknown>;
}
