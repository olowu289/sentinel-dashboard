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

/**
 * Which feeds the detector actually serves, ASKED rather than hardcoded.
 *
 * The engine publishes its feed list at /healthz. Keeping a copy here meant
 * two places had to agree about which cameras exist, and they could silently
 * drift - a feed added to the engine's config would simply never appear.
 *
 * Cached at module level so four tiles share one request, and re-polled slowly
 * so the dashboard notices an engine that restarted with a different set (or
 * came back at all) without a page reload.
 */
export interface EngineFeed {
  name: string;
  detect: boolean;
  steers: boolean;
  /** The port THIS feed's video is served on. The engine gives every feed its
   * own port because a browser caps connections per host:port, and four tiles
   * sharing one port starved each other to black. Reported rather than
   * computed so the numbering stays the engine's business. */
  port: number;
}

const ENGINE_POLL_MS = 15000;

/** The port we ASK on. Each feed answers with the port it is served from. */
function discoveryPort(): number {
  const p = Number(SINGLE_SOURCE_HOST.split(':')[1]);
  return Number.isFinite(p) ? p : 8090;
}

function engineHostname(): string {
  return SINGLE_SOURCE_HOST.split(':')[0];
}

let engineFeeds: EngineFeed[] = [];
let polling = false;
const listeners = new Set<(f: EngineFeed[]) => void>();

async function pollEngine(): Promise<void> {
  let next: EngineFeed[] = [];
  try {
    const res = await fetch(`http://${SINGLE_SOURCE_HOST}/healthz`, { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { feeds?: unknown };
      if (Array.isArray(body.feeds)) {
        next = body.feeds
          .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
          .map((f) => ({
            name: String(f.name ?? ''),
            detect: f.detect === true,
            steers: f.steers === true,
            // Older engines served every feed from the discovery port; fall
            // back to it so a mismatched pair still shows video.
            port: typeof f.port === 'number' ? f.port : discoveryPort(),
          }))
          .filter((f) => f.name !== '');
      }
    }
  } catch {
    // Engine unreachable. An empty list is the honest answer, and it makes
    // every tile fall back to the tower's own WHEP rather than showing
    // nothing - the picture matters more than the boxes.
    next = [];
  }
  const changed =
    next.length !== engineFeeds.length
    || next.some((f, i) => f.name !== engineFeeds[i]?.name || f.detect !== engineFeeds[i]?.detect);
  engineFeeds = next;
  if (changed) listeners.forEach((l) => l(next));
}

function ensurePolling(): void {
  if (polling) return;
  polling = true;
  void pollEngine();
  window.setInterval(() => void pollEngine(), ENGINE_POLL_MS);
}

/** Subscribe to the engine's feed list. Returns the latest known value. */
export function subscribeEngineFeeds(cb: (f: EngineFeed[]) => void): () => void {
  ensurePolling();
  listeners.add(cb);
  cb(engineFeeds);
  return () => listeners.delete(cb);
}

export function singleSourceAvailable(camPath: string, feeds: EngineFeed[]): boolean {
  return SINGLE_SOURCE_ENABLED && feeds.some((f) => f.name === camPath);
}

/**
 * AI ON  -> /ai  : annotated frames, boxes burned in, carries the inference
 *                  delay (measured ~6-8ms publish->socket on the PC, plus one
 *                  frame interval to present).
 * AI OFF -> /raw : straight from capture, never waits on inference.
 * Both are served by the same process off the same capture thread, so
 * switching between them costs nothing upstream.
 */
export function singleSourceUrl(camPath: string, ai: boolean, port?: number): string {
  const host = port ? `${engineHostname()}:${port}` : SINGLE_SOURCE_HOST;
  return `http://${host}/${camPath}/${ai ? 'ai' : 'raw'}`;
}

/** The port a feed's video is on, or the discovery port if unknown. */
export function feedPort(camPath: string, feeds: EngineFeed[]): number {
  return feeds.find((f) => f.name === camPath)?.port ?? discoveryPort();
}
