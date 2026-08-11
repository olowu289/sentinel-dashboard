import { LOCAL_CONTROL_HOST } from './videoSourceMode';

/**
 * The AI-tracking master switch (see gateway.py's /api/ai/tracking and
 * kallon_ai_bridge.py's TRACKING_STATE_PATH for the full state model).
 * Direct calls to the Jetson's own gateway, same as localPtzApi.ts and for
 * the same reason: this is tower-local safety-relevant state with no
 * platform/Railway route today (nothing has needed one yet - every AI
 * tracking task this far has been done LAN-side). No API key sent -
 * gateway.py has no authentication of any kind (see localPtzApi.ts's own
 * note on this).
 */

export interface AiTrackingState {
  armed: boolean;
  engine_connected: boolean;
  tracking_capable: boolean;
}

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
    const wrapped = new Error('local control unreachable') as Error & { code?: string };
    wrapped.code = 'local_unreachable';
    wrapped.cause = err;
    throw wrapped;
  }
  const resBody: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errObj = (resBody as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = typeof errObj?.code === 'string' ? errObj.code : undefined;
    const msg = (typeof errObj?.message === 'string' && errObj.message) || res.statusText;
    const err = new Error(typeof msg === 'string' && msg ? msg : `HTTP ${res.status}`) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  }
  return resBody as T;
}

export function localGetAiTracking(): Promise<AiTrackingState> {
  return localRequest('GET', '/api/ai/tracking');
}

export function localSetAiTracking(armed: boolean): Promise<AiTrackingState> {
  return localRequest('POST', '/api/ai/tracking', { armed });
}
