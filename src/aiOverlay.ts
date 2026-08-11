import { decode } from '@msgpack/msgpack';
import { aiStreamByNameUrl, aiStreamStateUrl, AI_WS_TOKEN, AI_VIEW_MIN_CONF, aiWsUrls } from './aiConfig';

/**
 * Detection-overlay engine, extracted out of the old fullscreen AiDetectionView
 * so a camera tile can draw boxes directly on its own existing video instead of
 * opening a separate popup with its own WHEP feed from the engine. Deliberately
 * video-connection-agnostic: this only ever talks to the engine's detection WS
 * (ws://<engine>/v1/ws) — see AiOverlayCanvas.tsx for how it's drawn onto
 * whatever video a tile happens to be playing (cable or platform).
 */

const DETECTION_BUFFER_SIZE = 30;
const FRAME_SEQ_BACKWARD_JUMP = 30;
const STREAM_STATE_POLL_MS = 5000;
const DEFAULT_OWNER = 'sentinel';
const COUNT_TICK_MS = 1000;

export interface Detection { bbox: [number, number, number, number]; name: string; conf: number; }

export interface DetectionBody {
  stream_id: string;
  pipeline_epoch: number;
  frame_seq: number;
  source_width: number;
  source_height: number;
  detections: Detection[];
  /**
   * NOT part of the documented wire schema (see ai-integration.md) — every
   * message observed from the engine omits this. Checked defensively.
   */
  ingest_ts_ns?: number | bigint;
}

export type LinkState = 'connecting' | 'open' | 'error';

export interface AiOverlayHandlers {
  onWsState?: (state: LinkState) => void;
  onStreamEngineState?: (state: string | null) => void;
  /** Fired once a second with (detections seen, detections surviving AI_VIEW_MIN_CONF). */
  onCounts?: (detPerSec: number, shownPerSec: number) => void;
  /**
   * Fired for every detection message with the raw, unfiltered
   * `detections[]` array — same objects the canvas draws from, before the
   * AI_VIEW_MIN_CONF display filter. Consumers (e.g. the class-agnostic
   * detection-alert banner) apply their own threshold rather than reusing
   * the display one, since "draw a faint box" and "flash a page-wide alert"
   * are different bars.
   */
  onDetections?: (detections: Detection[]) => void;
}

export interface AiOverlayHandle {
  /** Most recently buffered detection frame, or undefined before the first one arrives. */
  getLatest(): DetectionBody | undefined;
  close(): void;
}

/**
 * Resolves streamName -> stream_id, opens the detection WS (artemis
 * subprotocol, msgpack frames), and keeps a small rolling buffer with the
 * same epoch/frame_seq coherence guards AiDetectionView used: a pipeline
 * restart (epoch change) or a big backward frame_seq jump clears stale
 * buffered boxes rather than smearing them across a new run.
 */
export function connectAiOverlay(streamName: string, handlers: AiOverlayHandlers = {}): AiOverlayHandle {
  let cancelled = false;
  let ws: WebSocket | null = null;
  let pollTimer: number | null = null;
  let streamId: string | null = null;

  const buffer: DetectionBody[] = [];
  let lastEpoch: number | null = null;
  let lastFrameSeq: number | null = null;
  let detCount = 0;
  let shownCount = 0;

  const clearBuffer = () => {
    buffer.length = 0;
    lastEpoch = null;
    lastFrameSeq = null;
  };

  const connectWs = (urls: string[], idx: number) => {
    if (cancelled) return;
    if (idx >= urls.length) { handlers.onWsState?.('error'); return; }
    const socket = new WebSocket(urls[idx], ['artemis', AI_WS_TOKEN]);
    socket.binaryType = 'arraybuffer';
    let openedOnce = false;
    socket.onopen = () => {
      openedOnce = true;
      if (cancelled) return;
      handlers.onWsState?.('open');
      clearBuffer();
    };
    socket.onmessage = (ev) => {
      if (cancelled) return;
      let msg: unknown;
      try {
        msg = decode(new Uint8Array(ev.data as ArrayBuffer));
      } catch {
        return; // malformed frame — tolerate per protocol doc, don't error out
      }
      const m = msg as { type?: string; body?: DetectionBody };
      if (m?.type !== 'detection' || !m.body) return;
      if (!streamId || m.body.stream_id !== streamId) return;

      const body = m.body;
      if (lastEpoch !== null && body.pipeline_epoch !== lastEpoch) {
        clearBuffer();
      } else if (lastFrameSeq !== null && body.frame_seq < lastFrameSeq - FRAME_SEQ_BACKWARD_JUMP) {
        clearBuffer();
      }
      lastEpoch = body.pipeline_epoch;
      lastFrameSeq = body.frame_seq;
      buffer.push(body);
      if (buffer.length > DETECTION_BUFFER_SIZE) buffer.shift();
      handlers.onDetections?.(body.detections);

      // Counts individual boxes (not messages) so det/s vs shown/s are
      // directly comparable — "how many of the incoming detections
      // actually survive the display filter".
      detCount += body.detections.length;
      shownCount += body.detections.filter((d) => d.conf >= AI_VIEW_MIN_CONF).length;
    };
    socket.onclose = () => {
      if (cancelled) return;
      if (!openedOnce) { connectWs(urls, idx + 1); return; }
      handlers.onWsState?.('error');
    };
    ws = socket;
  };

  (async () => {
    try {
      const res = await fetch(aiStreamByNameUrl(streamName), { headers: { 'X-Owner': DEFAULT_OWNER } });
      if (!res.ok) throw new Error(`stream lookup HTTP ${res.status}`);
      const data = await res.json();
      if (cancelled) return;
      streamId = data.stream_id;

      const pollState = async () => {
        try {
          const r = await fetch(aiStreamStateUrl(data.stream_id), {
            headers: { 'X-Owner': DEFAULT_OWNER },
          });
          if (r.ok) {
            const detail = await r.json();
            if (!cancelled) handlers.onStreamEngineState?.(detail?.state ?? null);
          }
        } catch { /* best-effort — status line just omits it */ }
      };
      pollState();
      pollTimer = window.setInterval(pollState, STREAM_STATE_POLL_MS);

      connectWs(aiWsUrls(), 0);
    } catch {
      if (!cancelled) handlers.onWsState?.('error');
    }
  })();

  const countTimer = window.setInterval(() => {
    if (cancelled) return;
    handlers.onCounts?.(detCount, shownCount);
    detCount = 0;
    shownCount = 0;
  }, COUNT_TICK_MS);

  return {
    getLatest: () => buffer[buffer.length - 1],
    close: () => {
      cancelled = true;
      ws?.close();
      if (pollTimer) window.clearInterval(pollTimer);
      window.clearInterval(countTimer);
    },
  };
}

/**
 * Draws the most recently buffered detection set onto a canvas sized to the
 * video's rendered box, scaled from the detection frame's own
 * source_width/height. `objectFit` must match the actual <video>'s CSS
 * object-fit so the scale/offset math lines up with what's really on
 * screen — 'contain' letterboxes (scale = min of the two axis ratios),
 * 'cover' fills-and-crops (scale = max; the displayed rect can extend past
 * the box on the cropped axis, which is fine — canvas clips at its own
 * edges automatically). Separate sx/sy factors (not one shared scale) mean
 * this is correct even when the video's own resolution differs from the
 * detector's 1920x1080 source (e.g. a 704x576 substream) as long as both
 * come from the same lens/framing, which they do here.
 *
 * v1 simplification carried over from AiDetectionView: always draws the
 * latest buffered set rather than matching frame_seq to the decoded video
 * frame on screen — tile video and detections are separate paths (see
 * aiOverlay.ts's module doc), so boxes can visibly lead/lag by up to one
 * detection interval. Fine for live ops, not a calibrated overlay.
 */
export function drawAiOverlay(
  ctx: CanvasRenderingContext2D,
  boxW: number,
  boxH: number,
  video: HTMLVideoElement,
  latest: DetectionBody | undefined,
  objectFit: 'contain' | 'cover',
  style: { stroke: string; font: string },
): void {
  ctx.clearRect(0, 0, boxW, boxH);
  if (!latest || !video.videoWidth || !video.videoHeight) return;

  const scale = objectFit === 'cover'
    ? Math.max(boxW / video.videoWidth, boxH / video.videoHeight)
    : Math.min(boxW / video.videoWidth, boxH / video.videoHeight);
  const dispW = video.videoWidth * scale;
  const dispH = video.videoHeight * scale;
  const offsetX = (boxW - dispW) / 2;
  const offsetY = (boxH - dispH) / 2;
  const sx = dispW / latest.source_width;
  const sy = dispH / latest.source_height;

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = style.stroke;
  ctx.font = style.font;
  for (const d of latest.detections) {
    if (d.conf < AI_VIEW_MIN_CONF) continue;
    const [x, y, w, h] = d.bbox;
    const rx = offsetX + x * sx;
    const ry = offsetY + y * sy;
    const rw = w * sx;
    const rh = h * sy;
    ctx.strokeRect(rx, ry, rw, rh);
    const label = `${d.name} ${Math.round(d.conf * 100)}%`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,12,16,.82)';
    ctx.fillRect(rx, Math.max(0, ry - 16), tw + 8, 16);
    ctx.fillStyle = style.stroke;
    ctx.fillText(label, rx + 4, Math.max(11, ry - 4));
  }
}
