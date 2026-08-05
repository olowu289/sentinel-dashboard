/**
 * Thin client for the Platform API's WHEP (WebRTC-HTTP Egress Protocol) routes.
 * Mirrors recordingsApi.ts's apiJson error-shaping (same {error:{code,message}}
 * envelope, same Error-with-.code shape consumed by util.ts's errCode/FRIENDLY),
 * but the success bodies here are raw SDP text, not JSON.
 *
 * Non-trickle only: PATCH (ICE trickle) is intentionally not implemented. MediaMTX's
 * WHEP answer already includes a full ICE candidate set upfront (verified against the
 * live backend), so LiveWebrtcVideo.tsx gathers candidates to completion client-side
 * and sends one offer — no PATCH round trip needed for v1.
 */

export interface WhepAuth {
  apiKey: string;
  ngrok?: boolean;
}

export interface WhepSession {
  answerSdp: string;
  sessionUrl: string;
}

function authHeaders(auth: WhepAuth, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (auth.apiKey) headers['X-Kallon-Api-Key'] = auth.apiKey;
  if (auth.ngrok) headers['ngrok-skip-browser-warning'] = '1';
  return headers;
}

async function errorFromResponse(res: Response): Promise<Error & { code?: string }> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  const errObj = (body as { error?: { code?: unknown; message?: unknown } }).error;
  const code = typeof errObj?.code === 'string' ? errObj.code : undefined;
  const msg =
    (typeof errObj?.message === 'string' && errObj.message)
    || (body as { detail?: string }).detail
    || res.statusText;
  const err = new Error(msg || `HTTP ${res.status}`) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

/** POST an SDP offer, return the SDP answer + the absolute session URL for PATCH/DELETE. */
export async function postWhepOffer(
  auth: WhepAuth,
  whepUrl: string,
  offerSdp: string,
): Promise<WhepSession> {
  const res = await fetch(whepUrl, {
    method: 'POST',
    headers: authHeaders(auth, { 'Content-Type': 'application/sdp' }),
    body: offerSdp,
  });
  if (!res.ok) throw await errorFromResponse(res);
  const location = res.headers.get('Location');
  if (!location) {
    throw new Error('WHEP response missing Location header (session URL) — cannot manage session lifecycle');
  }
  const answerSdp = await res.text();
  const sessionUrl = new URL(location, new URL(whepUrl).origin).toString();
  return { answerSdp, sessionUrl };
}

/** Best-effort session teardown — 204 even if already gone server-side; never throws. */
export async function deleteWhepSession(auth: WhepAuth, sessionUrl: string): Promise<void> {
  try {
    await fetch(sessionUrl, {
      method: 'DELETE',
      headers: authHeaders(auth),
      keepalive: true,
    });
  } catch {
    // Best-effort — a failed DELETE here just means the hub/MediaMTX session
    // ages out on its own idle timer instead of being torn down immediately.
  }
}
