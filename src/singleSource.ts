/**
 * SINGLE-SOURCE video: the annotated MJPEG stream published by
 * infra/tools/local_detect.py on the operator's own PC.
 *
 * The point of this path is that the boxes are BURNED IN by the detector, on
 * the exact frame they were computed from, and the same detection record also
 * feeds the tracker's steering coordinates (see local_detect.py's
 * AnnotatedRecord and kallon_ai_bridge.py's DetectionSlot.frame_seq). So what
 * the operator sees IS what the camera is acting on - they cannot drift apart,
 * because there is one record rather than two feeds to correlate.
 *
 * That is the difference from the older client-side overlay path
 * (AiOverlayCanvas / AiFrameSyncOverlay), which draws boxes in the browser on
 * top of a separately-arriving video stream and has to reconstruct the
 * correspondence after the fact. That path is deliberately left intact and is
 * still the default - flip SINGLE_SOURCE_ENABLED on to use this one.
 *
 * Fully offline over the cable: local_detect pulls RTSP from the Jetson's own
 * mediamtx on the camera island and serves this stream from the PC. Nothing
 * here touches the Artemis engine (which lives on the WiFi side) or the hub.
 */

/** Host:port local_detect.py's MjpegServer is bound to (its mjpeg_host /
 * mjpeg_port). Loopback by default, matching local_detect's own safe default:
 * that works when the dashboard runs in a browser on the SAME PC as the
 * detector. If the dashboard runs on a different island machine, point this at
 * the detector PC's camera-island address AND bind local_detect there too. */
export const SINGLE_SOURCE_HOST =
  (import.meta.env.VITE_SINGLE_SOURCE_HOST as string | undefined)?.trim() || '127.0.0.1:8090';

/** Off by default: turning it on changes where cam1's video comes from, so it
 * is an explicit deployment choice, not a silent default. The previous
 * WHEP/HLS + client-side-overlay path stays wired and is used whenever this is
 * false - that is the revert path. */
export const SINGLE_SOURCE_ENABLED =
  ((import.meta.env.VITE_SINGLE_SOURCE_ENABLED as string | undefined)?.trim() || '') === '1';

/** Cameras served by the local detector. Only cam1 has a model pointed at it. */
export const SINGLE_SOURCE_CAMS = new Set(['cam1']);

export function singleSourceAvailable(camPath: string): boolean {
  return SINGLE_SOURCE_ENABLED && SINGLE_SOURCE_CAMS.has(camPath);
}

/**
 * AI ON  -> /ai  : annotated frames, boxes burned in, carries the inference
 *                  delay (measured ~6-8ms publish->socket on the PC, plus one
 *                  frame interval to present).
 * AI OFF -> /raw : straight from capture, never waits on inference.
 * Both are served by the same process off the same capture thread, so
 * switching between them costs nothing upstream.
 */
export function singleSourceUrl(camPath: string, ai: boolean): string {
  return `http://${SINGLE_SOURCE_HOST}/${camPath}/${ai ? 'ai' : 'raw'}`;
}
