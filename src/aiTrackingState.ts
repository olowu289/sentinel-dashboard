import { localGetAiTracking, localSetAiTracking, type AiTrackingState } from './aiTrackingApi';

/**
 * Shared poll + pub/sub for the AI-tracking master switch, mirroring
 * aiDetectionAlert.ts's own singleton pattern (same reasoning: the toggle
 * control and the "ARMED" banner live in different parts of the component
 * tree - DashboardConsole vs FleetApp - with no shared parent state already
 * carrying this, and there should be exactly ONE poll loop, not one per
 * mount point).
 *
 * Fails safe on any read failure (gateway unreachable, not on the camera
 * LAN, etc.): shows disarmed/disconnected rather than holding onto a stale
 * "armed" from the last successful poll. The whole point of this feature
 * is "the operator always knows whether the camera might move on its own" -
 * a stale true reading during an outage would be exactly backwards.
 */

const POLL_MS = 2000;

const UNKNOWN_STATE: AiTrackingState = { armed: false, engine_connected: false, tracking_capable: false };

let current: AiTrackingState = UNKNOWN_STATE;
let reachable = false;
const listeners = new Set<(s: AiTrackingState, reachable: boolean) => void>();
let pollTimer: number | null = null;
let refCount = 0;

function notify(): void {
  listeners.forEach((l) => l(current, reachable));
}

async function poll(): Promise<void> {
  try {
    current = await localGetAiTracking();
    reachable = true;
  } catch {
    current = UNKNOWN_STATE;
    reachable = false;
  }
  notify();
}

export function subscribeAiTracking(listener: (s: AiTrackingState, reachable: boolean) => void): () => void {
  listeners.add(listener);
  listener(current, reachable);
  refCount += 1;
  if (pollTimer === null) {
    void poll();
    pollTimer = window.setInterval(() => void poll(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

/** Arms/disarms via the gateway, then immediately applies the returned
 * (authoritative) state rather than waiting for the next poll tick. Throws
 * on failure (unreachable, not tracking_capable, engine not connected) -
 * callers show the error, they don't need to guess from state alone. */
export async function setAiTrackingArmed(armed: boolean): Promise<AiTrackingState> {
  // eslint-disable-next-line no-console
  console.log('[ai-tracking] setAiTrackingArmed() called, no guard before this line', armed);
  current = await localSetAiTracking(armed);
  reachable = true;
  notify();
  return current;
}
