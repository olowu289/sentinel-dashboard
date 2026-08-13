/**
 * WHEP against the tower's own MediaMTX, on the LAN.
 *
 * The platform version of this file negotiated through the hub: an API key
 * header, an ngrok-skip header, and the platform's {error:{code,message}}
 * envelope on failure. None of that exists here. This talks to a plain
 * MediaMTX WHEP endpoint one hop away, which wants an SDP offer and nothing
 * else - sending an API key would imply an authentication step that neither
 * end performs.
 *
 * Non-trickle only, unchanged from the platform build and for the same
 * measured reason: MediaMTX's answer already carries a full ICE candidate set
 * upfront, so the browser gathers its own candidates to completion and sends
 * one offer. There is no PATCH round trip, and on a LAN there is nothing for
 * trickle to hide - candidate gathering against a host on the same switch
 * completes almost immediately.
 */

export interface WhepSession {
  answerSdp: string;
  sessionUrl: string;
}

async function errorFromResponse(res: Response): Promise<Error> {
  // MediaMTX answers failures with plain text, not the platform's JSON
  // envelope, so there is no error code to extract - just say what happened.
  const body = await res.text().catch(() => '');
  return new Error(body.trim() || res.statusText || `HTTP ${res.status}`);
}

/** POST an SDP offer, return the answer plus the absolute session URL for DELETE. */
export async function postWhepOffer(whepUrl: string, offerSdp: string): Promise<WhepSession> {
  const res = await fetch(whepUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offerSdp,
  });
  if (!res.ok) throw await errorFromResponse(res);
  const location = res.headers.get('Location');
  if (!location) {
    // Without this we cannot tear the session down, and MediaMTX would hold
    // the reader open until it times out on its own.
    throw new Error('WHEP response missing Location header — cannot manage the session');
  }
  return {
    answerSdp: await res.text(),
    sessionUrl: new URL(location, new URL(whepUrl).origin).toString(),
  };
}

/** Best-effort teardown. A 404 means it is already gone, which is the
 * outcome we wanted anyway. */
export async function deleteWhepSession(sessionUrl: string): Promise<void> {
  try {
    await fetch(sessionUrl, { method: 'DELETE', keepalive: true });
  } catch { /* the session dies with the page regardless */ }
}
