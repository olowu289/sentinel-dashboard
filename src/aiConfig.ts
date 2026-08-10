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

/** Engine LAN host, no protocol/port. */
export const AI_ENGINE_HOST = RAW_HOST.replace(/\/$/, '');

/** Perception Engine REST + detection-WS port. */
export const AI_ENGINE_API_PORT = 7788;

/** Engine's own MediaMTX WHEP port (separate from the SRT ingest port). */
export const AI_ENGINE_WHEP_PORT = 8889;

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
export const AI_VIEW_MIN_CONF = 0.7;

export function aiStreamNameFor(cameraPath: string): string | undefined {
  return AI_STREAM_MAP[cameraPath];
}

export function aiWhepUrl(streamName: string): string {
  return `http://${AI_ENGINE_HOST}:${AI_ENGINE_WHEP_PORT}/${streamName}/whep`;
}

export function aiStreamByNameUrl(streamName: string): string {
  return `http://${AI_ENGINE_HOST}:${AI_ENGINE_API_PORT}/v1/streams/by-name/${encodeURIComponent(streamName)}`;
}

/**
 * Candidate detection-WS URLs, in try-order. client.html (verified against
 * the engine's own reference UI) uses /v1/ws; the standalone protocol doc
 * also settled on /v1/ws after an earlier draft assumed /ws — kept as a
 * fallback in case a given engine build still serves the old path.
 */
export function aiWsUrls(): string[] {
  return [
    `ws://${AI_ENGINE_HOST}:${AI_ENGINE_API_PORT}/v1/ws`,
    `ws://${AI_ENGINE_HOST}:${AI_ENGINE_API_PORT}/ws`,
  ];
}
