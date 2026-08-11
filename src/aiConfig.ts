/**
 * "AI View" diagnostic feature — direct browser-to-engine connection to the
 * Perception Engine on the tower's own LAN (not proxied through the
 * Platform API). Expected to fail with a readable error from any network
 * that can't reach the engine host directly; that's by design, not a bug.
 *
 * Build-time override: VITE_AI_ENGINE_HOST (falls back to the known dev
 * engine IP). VITE_AI_WS_TOKEN overrides the dev WS subprotocol token.
 */
const RAW_HOST = (import.meta.env.VITE_AI_ENGINE_HOST as string | undefined)?.trim() || '192.168.1.236';

/** Engine LAN host, no protocol/port. Drives WHEP VIDEO only (aiWhepUrl) —
 * see AI_DETECTION_BASE_URL for the (separately switchable) detection source. */
export const AI_ENGINE_HOST = RAW_HOST.replace(/\/$/, '');

/** Perception Engine REST + detection-WS port. */
export const AI_ENGINE_API_PORT = 7788;

/** Engine's own MediaMTX WHEP port (separate from the SRT ingest port). */
export const AI_ENGINE_WHEP_PORT = 8889;

/**
 * Detection source (REST stream-resolve + WS) — deliberately a SEPARATE knob
 * from AI_ENGINE_HOST/AI_ENGINE_WHEP_PORT above, even though it defaults to
 * pointing at the same host:port. AI_ENGINE_HOST also drives WHEP video
 * (aiWhepUrl), and detections vs. video are genuinely independent concerns:
 * infra/tools/local_detect.py can serve byte-compatible detections (same WS
 * URL shape, subprotocol, msgpack schema) from an operator's own PC without
 * also serving video, so switching JUST the detection source must not
 * require - or accidentally break - the video path. One override:
 * VITE_AI_DETECTION_BASE_URL (e.g. "http://192.168.10.20:7789" to point at
 * local_detect.py's serve_ws mode instead of the real engine's :7788) - flip
 * it back to unset (or the engine's own http://<AI_ENGINE_HOST>:7788) to
 * switch back. Nothing downstream (AiOverlayCanvas, AiFrameSyncOverlay) needs
 * to change - both just call aiStreamByNameUrl/aiWsUrls below.
 */
export const AI_DETECTION_BASE_URL =
  (import.meta.env.VITE_AI_DETECTION_BASE_URL as string | undefined)?.trim().replace(/\/$/, '')
  || `http://${AI_ENGINE_HOST}:${AI_ENGINE_API_PORT}`;

/**
 * Dev-default WS subprotocol token, per client.html findings (Phase 0).
 * The detection WS currently has no real owner/token auth — this is offered
 * as a subprotocol for compatibility with whatever the server expects, not
 * because it's actually checked.
 */
export const AI_WS_TOKEN = (import.meta.env.VITE_AI_WS_TOKEN as string | undefined)?.trim() || 'artemis-dev';

/**
 * Cameras with a registered AI stream, keyed by Camera.path ("cam1").
 * Hardcoded for v1 — only tiles with an entry here render the AI VIEW button.
 * cam1 (.108) is the tower camera; cam2 (.109) is ground/test and has no AI
 * stream registered on the engine.
 */
export const AI_STREAM_MAP: Record<string, string> = {
  cam1: 'kallon_cam1_main',
};

/**
 * Minimum confidence for a detection to actually be DRAWN in the AI View
 * overlay. The engine's single-class drone-detr model fires sustained
 * high-confidence-looking boxes on static scenes (mesh fencing etc.) at
 * lower confidences — this is purely a display filter, independent of the
 * tower's own tracking/alert confidence thresholds (engage_confidence /
 * alert_confidence in ai_bridge.json), which are unaffected by this value.
 */
export const AI_VIEW_MIN_CONF = 0.5;

export function aiStreamNameFor(cameraPath: string): string | undefined {
  return AI_STREAM_MAP[cameraPath];
}

export function aiWhepUrl(streamName: string): string {
  return `http://${AI_ENGINE_HOST}:${AI_ENGINE_WHEP_PORT}/${streamName}/whep`;
}

export function aiStreamByNameUrl(streamName: string): string {
  return `${AI_DETECTION_BASE_URL}/v1/streams/by-name/${encodeURIComponent(streamName)}`;
}

/** GET .../v1/streams/{id} — engine-state poll, see AiOverlayCanvas/AiFrameSyncOverlay. */
export function aiStreamStateUrl(streamId: string): string {
  return `${AI_DETECTION_BASE_URL}/v1/streams/${encodeURIComponent(streamId)}`;
}

/**
 * Candidate detection-WS URLs, in try-order. client.html (verified against
 * the engine's own reference UI) uses /v1/ws; the standalone protocol doc
 * also settled on /v1/ws after an earlier draft assumed /ws — kept as a
 * fallback in case a given engine build still serves the old path.
 * Derives from AI_DETECTION_BASE_URL (http://...), not AI_ENGINE_HOST
 * directly, so switching detection source doesn't need its own http->ws
 * rewrite at every call site.
 */
export function aiWsUrls(): string[] {
  const wsBase = AI_DETECTION_BASE_URL.replace(/^http/, 'ws');
  return [`${wsBase}/v1/ws`, `${wsBase}/ws`];
}
