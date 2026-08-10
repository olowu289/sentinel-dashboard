import { decode } from '@msgpack/msgpack';
import { aiStreamByNameUrl, AI_ENGINE_HOST, AI_ENGINE_API_PORT, AI_WS_TOKEN, AI_VIEW_MIN_CONF, aiWsUrls } from './aiConfig';
import type { DetectionBody, LinkState } from './aiOverlay';

/**
 * Frame-ACCURATE detection correlation for Mode A's "AI Aligned View" (see
 * AiFrameSyncOverlay.tsx) - the sync-correct counterpart to aiOverlay.ts's
 * connectAiOverlay, which always draws the latest buffered detection on
 * whatever video frame happens to be on screen. That "latest-on-latest"
 * approach is exactly what produces visible drift against a MOVING drone
 * (see cam1's Mode B tile) - this module exists to fix that for Mode A,
 * where video and detections are the same source and genuine frame-locking
 * is possible.
 *
 * Deliberately a SEPARATE, self-contained module rather than a refactor of
 * aiOverlay.ts - cam1's tile must stay byte-for-byte unchanged, so this
 * duplicates the small amount of WS-connect/decode boilerplate rather than
 * sharing code cam1 also depends on. The actual canvas scaling/drawing
 * (drawAiOverlay) IS reused as-is from aiOverlay.ts - only WHICH detection
 * body gets handed to it differs.
 *
 * Per the Perception Engine reference doc (section 4): video (WebRTC/WHEP)
 * and detections (WS) are not perfectly in step, and once MediaMTX re-bases
 * RTP timestamps for WHEP, rtp_ts_ext can't be recovered from the decoded
 * video at all - so correlation has to be POSITIONAL: frame_seq against the
 * presented-frame index (video.requestVideoFrameCallback's presentedFrames
 * counter), calibrated ONCE per connection, not per-message timestamp
 * matching. See connectFrameSync's matchPresentedFrame.
 */

/** "Last ~2s of detection messages" per the doc's buffering guidance. */
const RING_WINDOW_MS = 2000;
/** Same convention as aiOverlay.ts's stale-buffer guard. */
const FRAME_SEQ_BACKWARD_JUMP = 30;
/** How many frame_seq units off a candidate can be and still count as a match. */
const MATCH_TOLERANCE_FRAMES = 5;
/** Fallback path only (no rVFC): how far off in wall-clock ms a candidate can be. */
const MATCH_TOLERANCE_MS = 300;
const STREAM_STATE_POLL_MS = 5000;
const DEFAULT_OWNER = 'sentinel';
const COUNT_TICK_MS = 1000;
/**
 * Fixed hold-back used ONLY when requestVideoFrameCallback isn't available -
 * without it we have no signal for which video frame is actually on screen,
 * so we degrade to "draw whatever detection arrived ~this long ago" instead
 * of a calibrated frame match. Roughly matches typical detection-to-WS
 * delivery latency observed on this engine.
 */
const FALLBACK_DELAY_MS = 150;

interface RingEntry {
  frameSeq: number;
  receivedAtMs: number; // performance.now() at message receipt
  body: DetectionBody;
}

export interface FrameSyncHandlers {
  onWsState?: (state: LinkState) => void;
  onStreamEngineState?: (state: string | null) => void;
  onCounts?: (detPerSec: number, shownPerSec: number) => void;
  /** Fired whenever calibration (re)locks or resets - the offset between
   * presented-frame index and detection frame_seq, surfaced in the tile's
   * stat chip so the correlation can be watched working. null = uncalibrated. */
  onCalibration?: (offset: number | null) => void;
  /** Fired once per second with the rolling match-hit-rate (0-100). */
  onMatchStats?: (hitRatePct: number) => void;
}

export interface FrameSyncHandle {
  /**
   * True frame-sync path: given requestVideoFrameCallback's presentedFrames
   * counter for the frame that was just painted, returns the best-matching
   * buffered detection - or undefined if nothing is within tolerance yet
   * (never blocks; see the doc's "render unannotated and move on" rule).
   * Locks calibration on first call that has both a presented frame and at
   * least one buffered detection ("both are live edge" - see module doc).
   */
  matchPresentedFrame(presentedFrames: number): DetectionBody | undefined;
  /** Fallback path (no rVFC): fixed-delay wall-clock match - degraded, not calibrated. */
  matchByDelay(): DetectionBody | undefined;
  close(): void;
}

export function connectFrameSync(streamName: string, handlers: FrameSyncHandlers = {}): FrameSyncHandle {
  let cancelled = false;
  let ws: WebSocket | null = null;
  let pollTimer: number | null = null;
  let streamId: string | null = null;

  const ring: RingEntry[] = [];
  let lastEpoch: number | null = null;
  let lastFrameSeq: number | null = null;
  let detCount = 0;
  let shownCount = 0;
  let hitCount = 0;
  let missCount = 0;

  let calibration: { frameSeqAtCal: number; presentedFramesAtCal: number } | null = null;

  const resetCalibration = () => {
    if (calibration !== null) {
      calibration = null;
      handlers.onCalibration?.(null);
    }
  };

  const clearRing = () => {
    ring.length = 0;
    lastEpoch = null;
    lastFrameSeq = null;
    resetCalibration();
  };

  const pruneRing = (nowMs: number) => {
    while (ring.length && nowMs - ring[0].receivedAtMs > RING_WINDOW_MS) ring.shift();
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
      clearRing(); // fresh connection - re-calibrate from scratch (doc's reset rule)
    };
    socket.onmessage = (ev) => {
      if (cancelled) return;
      let msg: unknown;
      try {
        msg = decode(new Uint8Array(ev.data as ArrayBuffer));
      } catch {
        return; // malformed frame - tolerate per protocol doc, don't error out
      }
      const m = msg as { type?: string; body?: DetectionBody };
      if (m?.type !== 'detection' || !m.body) return;
      if (!streamId || m.body.stream_id !== streamId) return;

      const body = m.body;
      const restarted =
        (lastEpoch !== null && body.pipeline_epoch !== lastEpoch) ||
        (lastFrameSeq !== null && body.frame_seq < lastFrameSeq - FRAME_SEQ_BACKWARD_JUMP);
      if (restarted) clearRing(); // "large backward frame_seq jump = stream restarted"

      lastEpoch = body.pipeline_epoch;
      lastFrameSeq = body.frame_seq;

      const nowMs = performance.now();
      ring.push({ frameSeq: body.frame_seq, receivedAtMs: nowMs, body });
      pruneRing(nowMs);

      detCount += body.detections.length;
      shownCount += body.detections.filter((d) => d.conf >= AI_VIEW_MIN_CONF).length;
    };
    socket.onclose = () => {
      if (cancelled) return;
      clearRing(); // "WS close" - discard + re-calibrate on reconnect
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
          const r = await fetch(`http://${AI_ENGINE_HOST}:${AI_ENGINE_API_PORT}/v1/streams/${data.stream_id}`, {
            headers: { 'X-Owner': DEFAULT_OWNER },
          });
          if (r.ok) {
            const detail = await r.json();
            if (!cancelled) handlers.onStreamEngineState?.(detail?.state ?? null);
          }
        } catch { /* best-effort */ }
      };
      pollState();
      pollTimer = window.setInterval(pollState, STREAM_STATE_POLL_MS);

      connectWs(aiWsUrls(), 0);
    } catch {
      if (!cancelled) handlers.onWsState?.('error');
    }
  })();

  const statsTimer = window.setInterval(() => {
    if (cancelled) return;
    handlers.onCounts?.(detCount, shownCount);
    detCount = 0;
    shownCount = 0;
    const total = hitCount + missCount;
    handlers.onMatchStats?.(total > 0 ? (hitCount / total) * 100 : 0);
    hitCount = 0;
    missCount = 0;
  }, COUNT_TICK_MS);

  const recordOutcome = (isHit: boolean) => {
    if (isHit) hitCount++; else missCount++;
  };

  return {
    matchPresentedFrame(presentedFrames: number): DetectionBody | undefined {
      let cal = calibration;
      if (cal === null) {
        // "on connect, assume the currently-arriving detections correspond
        // to the currently-presented video (both are live edge)" - lock the
        // offset the first time we have both a presented frame AND at
        // least one buffered detection to pair it with.
        const latest = ring[ring.length - 1];
        if (!latest) return undefined; // nothing to calibrate against yet - render unannotated
        cal = { frameSeqAtCal: latest.frameSeq, presentedFramesAtCal: presentedFrames };
        calibration = cal;
        handlers.onCalibration?.(cal.frameSeqAtCal - cal.presentedFramesAtCal);
      }
      const target = cal.frameSeqAtCal + (presentedFrames - cal.presentedFramesAtCal);
      let best: RingEntry | null = null;
      let bestDist = Infinity;
      for (const entry of ring) {
        const dist = Math.abs(entry.frameSeq - target);
        if (dist < bestDist) { bestDist = dist; best = entry; }
      }
      const isHit = best !== null && bestDist <= MATCH_TOLERANCE_FRAMES;
      recordOutcome(isHit);
      return isHit ? best!.body : undefined;
    },
    matchByDelay(): DetectionBody | undefined {
      const targetMs = performance.now() - FALLBACK_DELAY_MS;
      let best: RingEntry | null = null;
      let bestDist = Infinity;
      for (const entry of ring) {
        const dist = Math.abs(entry.receivedAtMs - targetMs);
        if (dist < bestDist) { bestDist = dist; best = entry; }
      }
      const isHit = best !== null && bestDist <= MATCH_TOLERANCE_MS;
      recordOutcome(isHit);
      return isHit ? best!.body : undefined;
    },
    close(): void {
      cancelled = true;
      ws?.close();
      if (pollTimer) window.clearInterval(pollTimer);
      window.clearInterval(statsTimer);
    },
  };
}
