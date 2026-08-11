import { useEffect, useState } from 'react';
import { subscribeAiTracking } from '../aiTrackingState';
import type { AiTrackingState } from '../aiTrackingApi';

/**
 * Global, always-visible-while-armed indicator that autonomous AI tracking
 * may move the camera right now. Deliberately NOT styled like
 * TargetCueBanner/AiDetectionBanner (flash-then-fade, full-width top bar) -
 * this is a STANDING state, not a transient event, so it stays on screen
 * steadily for as long as armed is true instead of animating in/out. A
 * compact corner badge rather than a full-width bar so it doesn't compete
 * with those two for the same "top of screen" lane if all three happen to
 * be active together.
 *
 * Mounted once in FleetApp, same reasoning as the other two banners: the
 * operator should see this regardless of which view (Live/Sensors/Alerts/
 * Recordings) they're currently on.
 */
export default function AiTrackingBanner() {
  const [state, setState] = useState<AiTrackingState>({ armed: false, engine_connected: false, tracking_capable: false });

  useEffect(() => subscribeAiTracking((s) => setState(s)), []);

  if (!state.armed) return null;

  return (
    <div className="ai-tracking-badge" role="status">
      <span className="ai-tracking-dot" aria-hidden="true" />
      AI TRACKING ARMED
    </div>
  );
}
