/**
 * Video/control-source mode: "platform" (default) streams video AND routes
 * PTZ via the hub/Railway platform path — unchanged existing behavior.
 * "local" streams direct WHEP from the Jetson's own MediaMTX AND sends PTZ
 * commands direct to the Jetson's own gateway, both over the LAN/cable,
 * bypassing the hub entirely for both (see scripts/install/50-mediamtx.sh's
 * webrtc block + CAMERA_RTSP_LAN_ACCESS for video, and gateway.py's third
 * listener + CAMERA_CONTROL_LAN_ACCESS for control, both in
 * 90-firewall.sh/device.env on the Jetson side).
 *
 * Deliberately NOT gated on the hub-reported camera status: local mode's
 * whole point is working when the hub/internet path is degraded but the
 * browser is still physically on the camera segment, so it always attempts
 * the direct connection and lets the transport itself report success or
 * failure (see LiveVideo's localMode prop and localPtzApi.ts's errors).
 *
 * One toggle governs both video and control together on purpose — running
 * video local while control silently stays on the platform (or vice versa)
 * would hide which path is actually live, exactly the confusion this is
 * meant to avoid.
 */
export type VideoSourceMode = 'platform' | 'local';

const MODE_STORAGE_KEY = 'sentinel-video-source-mode';

/** Build-time default for the Jetson's local MediaMTX WHEP host:port —
 * override per-deployment with VITE_LOCAL_VIDEO_HOST. */
export const LOCAL_VIDEO_HOST =
  (import.meta.env.VITE_LOCAL_VIDEO_HOST as string | undefined)?.trim() || '192.168.10.2:8889';

/** Build-time default for the Jetson's own gateway host:port (PTZ/control) —
 * override per-deployment with VITE_LOCAL_CONTROL_HOST. Only reachable when
 * the Jetson has CAMERA_CONTROL_LAN_ACCESS=1 (see 90-firewall.sh) — NOT the
 * same flag as video's CAMERA_RTSP_LAN_ACCESS, by design. */
export const LOCAL_CONTROL_HOST =
  (import.meta.env.VITE_LOCAL_CONTROL_HOST as string | undefined)?.trim() || '192.168.10.2:8766';

export function loadVideoSourceMode(): VideoSourceMode {
  try {
    if (localStorage.getItem(MODE_STORAGE_KEY) === 'local') return 'local';
  } catch { /* private mode / storage disabled — fall through to the default */ }
  return 'platform';
}

export function saveVideoSourceMode(mode: VideoSourceMode): void {
  try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* best-effort */ }
}

/** Direct WHEP create-session URL against the Jetson's own MediaMTX — no
 * device_id/hub hop. No API key: this is a raw LAN client, key-gated only
 * on the platform path (see webrtcApi.ts's authHeaders — an empty apiKey
 * simply omits the X-Kallon-Api-Key header, which is exactly what a plain
 * mediamtx WHEP endpoint expects). */
export function localWhepUrl(camPath: string): string {
  return `http://${LOCAL_VIDEO_HOST}/${camPath}/whep`;
}
