import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { decode } from '@msgpack/msgpack';
import { colors, font } from '../tokens';
import {
  aiStreamByNameUrl, aiWhepUrl, aiWsUrls, AI_WS_TOKEN, AI_ENGINE_HOST, AI_ENGINE_API_PORT,
} from '../aiConfig';

/**
 * Diagnostic viewer: direct WHEP video from the Perception Engine's own
 * MediaMTX + a msgpack detection-WS overlay. Deliberately "dumb" compared to
 * LiveWebrtcVideo — no make-before-break resync, no HLS fallback, no
 * stream-starting retry probes. Does borrow LiveWebrtcVideo's two known
 * latency cures: a jitterBufferTarget hint, and (a much cheaper version of
 * its drift watchdog) a periodic seek-to-live snap instead of rebuilding
 * the session. A LAN-reachability failure on either leg surfaces as a plain
 * message, never an infinite spinner.
 *
 * Renders as a floating, draggable/resizable panel IN the dashboard page
 * (not a popup window — window.open() broke config context for this view
 * and leaked WHEP sessions on dashboard close). The dashboard behind stays
 * fully interactive: there's no backdrop, so you can operate PTZ while
 * watching this.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const ICE_GATHER_TIMEOUT_MS = 3500;
const CONNECT_TIMEOUT_MS = 8000;
const DETECTION_BUFFER_SIZE = 30;
const FRAME_SEQ_BACKWARD_JUMP = 30;
const STREAM_STATE_POLL_MS = 5000;
const UNREACHABLE_MSG = 'AI engine unreachable from this network';
const DEFAULT_OWNER = 'sentinel';
/** How often the drift guard checks currentTime advance vs wall clock. */
const DRIFT_CHECK_MS = 10000;
/**
 * video.buffered is ALWAYS an empty TimeRanges when srcObject is a
 * MediaStream (spec behavior, not a bug in this code) — a live stream has no
 * preloaded-data concept to seek within. The old "seek to buffered.end()"
 * snap therefore never fired; `if (video.buffered.length)` was always false.
 * Fixed correction ladder instead: past CATCHUP_SEC, nudge playbackRate up
 * to gradually consume the excess jitter buffer (imperceptible, standard
 * live-latency technique); past HARD_RESYNC_SEC, playbackRate alone isn't
 * closing the gap fast enough — tear down and renegotiate a fresh session.
 */
const DRIFT_CATCHUP_SEC = 2;
const DRIFT_HARD_RESYNC_SEC = 5;
const DRIFT_CATCHUP_RATE = 1.08;
const STATS_POLL_MS = 2000;
/** Rolling window size for the engine->browser detection-metadata latency average. */
const DET_LATENCY_WINDOW = 30;

/** Default panel size as a fraction of the viewport, and the floor it can be resized down to. */
const DEFAULT_SIZE_RATIO = 0.7;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 270;

interface PanelRect { x: number; y: number; w: number; h: number; }

function defaultRect(): PanelRect {
  const w = Math.max(MIN_WIDTH, Math.round(window.innerWidth * DEFAULT_SIZE_RATIO));
  const h = Math.max(MIN_HEIGHT, Math.round(window.innerHeight * DEFAULT_SIZE_RATIO));
  return { x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2), w, h };
}

interface Detection { bbox: [number, number, number, number]; name: string; conf: number; }
interface DetectionBody {
  stream_id: string;
  pipeline_epoch: number;
  frame_seq: number;
  source_width: number;
  source_height: number;
  detections: Detection[];
  /**
   * NOT part of the documented wire schema (see ai-integration.md) — every
   * message observed from the engine omits this. Checked defensively; if it
   * shows up in practice the detection-latency stat below picks it up
   * automatically, but as of this writing it's never present.
   */
  ingest_ts_ns?: number | bigint;
}

type LinkState = 'connecting' | 'open' | 'error';

interface Props {
  streamName: string;
  cameraLabel: string;
  onClose: () => void;
}

async function postWhepOffer(whepUrl: string, offerSdp: string): Promise<{ answerSdp: string; sessionUrl: string }> {
  const res = await fetch(whepUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offerSdp,
  });
  if (!res.ok) throw new Error(`WHEP offer rejected (HTTP ${res.status})`);
  const location = res.headers.get('Location');
  const answerSdp = await res.text();
  const sessionUrl = location ? new URL(location, new URL(whepUrl).origin).toString() : whepUrl;
  return { answerSdp, sessionUrl };
}

function deleteWhepSession(sessionUrl: string): void {
  fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
}

export default function AiDetectionView({ streamName, cameraLabel, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [whepState, setWhepState] = useState<LinkState>('connecting');
  const [wsState, setWsState] = useState<LinkState>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [streamEngineState, setStreamEngineState] = useState<string | null>(null);
  const [detPerSec, setDetPerSec] = useState(0);
  const [statsText, setStatsText] = useState('');
  /** Bumped to force the WHEP effect to tear down and renegotiate a fresh
   * session — the hard-resync fallback when playbackRate catch-up alone
   * isn't closing the gap fast enough. */
  const [epoch, setEpoch] = useState(0);

  // Floating panel geometry — draggable by the header, resizable by the
  // corner grip. Lazy-initialized once per mount (a fresh mount happens
  // when the parent switches cameras via `key`, which resets to the
  // default centered rect — reopening the SAME camera never remounts, so
  // dragging/resizing persists rather than a second instance stacking).
  const [rect, setRect] = useState<PanelRect>(defaultRect);
  const [fullscreen, setFullscreen] = useState(false);
  const dragRef = useRef<{ pointerX: number; pointerY: number; startX: number; startY: number } | null>(null);
  const resizeRef = useRef<{ pointerX: number; pointerY: number; startW: number; startH: number } | null>(null);

  const bufferRef = useRef<DetectionBody[]>([]);
  const lastEpochRef = useRef<number | null>(null);
  const lastFrameSeqRef = useRef<number | null>(null);
  const detCountRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  /** Drift guard state — see the WHEP effect below. */
  const driftCheckRef = useRef<{ wallMs: number; videoTime: number } | null>(null);
  const cumulativeLagSecRef = useRef(0);
  const catchingUpRef = useRef(false);
  const snapCountRef = useRef(0);
  /** getStats() delta-calc state, same pattern LiveWebrtcVideo uses for fps/jitterBufferMs. */
  const prevFramesDecodedRef = useRef<number | null>(null);
  const prevFramesAtMsRef = useRef<number | null>(null);
  const prevBytesReceivedRef = useRef<number | null>(null);
  const prevJitterBufferDelayRef = useRef<number | null>(null);
  const prevJitterBufferEmittedRef = useRef<number | null>(null);
  /** Rolling window of engine->browser detection-metadata latencies (ms), only ever
   * populated if a message actually carries ingest_ts_ns — see DetectionBody. */
  const detLatencySamplesRef = useRef<number[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Drag by the header — pointer-capture pattern (same one PtzPad uses):
  // capture on the element that received pointerdown so subsequent move/up
  // events keep arriving to it regardless of what's under the cursor.
  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (fullscreen) return;
    // Ignore drags started on a header button (close/fullscreen).
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerX: e.clientX, pointerY: e.clientY, startX: rect.x, startY: rect.y };
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.pointerX;
    const dy = e.clientY - drag.pointerY;
    setRect((r) => ({
      ...r,
      x: Math.min(Math.max(0, drag.startX + dx), Math.max(0, window.innerWidth - r.w)),
      y: Math.min(Math.max(0, drag.startY + dy), Math.max(0, window.innerHeight - r.h)),
    }));
  };
  const endHeaderDrag = () => { dragRef.current = null; };

  // Resize by the bottom-right corner grip — same pointer-capture pattern.
  const onGripPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (fullscreen) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { pointerX: e.clientX, pointerY: e.clientY, startW: rect.w, startH: rect.h };
  };
  const onGripPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize) return;
    const dx = e.clientX - resize.pointerX;
    const dy = e.clientY - resize.pointerY;
    setRect((r) => ({
      ...r,
      w: Math.min(Math.max(MIN_WIDTH, resize.startW + dx), window.innerWidth - r.x),
      h: Math.min(Math.max(MIN_HEIGHT, resize.startH + dy), window.innerHeight - r.y),
    }));
  };
  const endGripResize = () => { resizeRef.current = null; };

  // WHEP: minimal standalone player — no make-before-break resync, no HLS
  // fallback, no retry probes. Does have a drift guard (below) and a stats
  // poll for the readout in the JSX.
  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;
    let driftTimer: number | undefined;
    let statsTimer: number | undefined;
    const timeout = window.setTimeout(() => {
      if (!cancelled) { setWhepState('error'); setErrorMsg((m) => m ?? UNREACHABLE_MSG); }
    }, CONNECT_TIMEOUT_MS);

    (async () => {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pc.ontrack = (ev) => {
        if (!cancelled && videoRef.current) videoRef.current.srcObject = ev.streams[0];
      };
      pc.onconnectionstatechange = () => {
        if (cancelled || !pc) return;
        if (pc.connectionState === 'connected') { window.clearTimeout(timeout); setWhepState('open'); }
        else if (pc.connectionState === 'failed') { setWhepState('error'); setErrorMsg((m) => m ?? UNREACHABLE_MSG); }
      };
      pc.addTransceiver('video', { direction: 'recvonly' });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await Promise.race([
        new Promise<void>((resolve) => {
          if (pc!.iceGatheringState === 'complete') { resolve(); return; }
          const check = () => {
            if (pc!.iceGatheringState === 'complete') { pc!.removeEventListener('icegatheringstatechange', check); resolve(); }
          };
          pc!.addEventListener('icegatheringstatechange', check);
        }),
        new Promise<void>((resolve) => window.setTimeout(resolve, ICE_GATHER_TIMEOUT_MS)),
      ]);
      if (cancelled) return;
      const { answerSdp, sessionUrl: url } = await postWhepOffer(aiWhepUrl(streamName), pc.localDescription!.sdp);
      if (cancelled) { deleteWhepSession(url); pc.close(); return; }
      sessionUrl = url;
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (cancelled) return;

      // Hint a deeper jitter buffer (ms) to the decoder — same feature-checked
      // pattern as LiveWebrtcVideo; not all browsers support this property yet.
      for (const receiver of pc.getReceivers()) {
        if (receiver.track.kind !== 'video') continue;
        try {
          if ('jitterBufferTarget' in receiver) {
            (receiver as unknown as { jitterBufferTarget: number }).jitterBufferTarget = 250;
          }
        } catch { /* not supported in this browser — fine, it's just a hint */ }
      }

      // Fresh connection: reset drift/catch-up state. video.playbackRate is
      // reset explicitly too — it's the same <video> DOM node reused across
      // reconnects (React doesn't recreate it), so a stale 1.08 from a prior
      // connection's catch-up would otherwise carry over silently.
      driftCheckRef.current = null;
      cumulativeLagSecRef.current = 0;
      catchingUpRef.current = false;
      if (videoRef.current) videoRef.current.playbackRate = 1.0;

      driftTimer = window.setInterval(() => {
        const video = videoRef.current;
        if (!video || cancelled) return;
        const now = Date.now();
        const prev = driftCheckRef.current;
        if (prev) {
          const wallDeltaSec = (now - prev.wallMs) / 1000;
          const videoDeltaSec = video.currentTime - prev.videoTime;
          const lagBefore = cumulativeLagSecRef.current;
          cumulativeLagSecRef.current += wallDeltaSec - videoDeltaSec;
          const lag = cumulativeLagSecRef.current;

          if (lag > DRIFT_HARD_RESYNC_SEC) {
            console.info(`[ai-view] drift hard-resync firing (lag ${lagBefore.toFixed(1)}s -> ${lag.toFixed(1)}s) — reconnecting`);
            snapCountRef.current += 1;
            cumulativeLagSecRef.current = 0;
            catchingUpRef.current = false;
            video.playbackRate = 1.0;
            setEpoch((e) => e + 1);
            return; // effect is about to tear down; nothing else to do this tick
          }
          if (lag > DRIFT_CATCHUP_SEC) {
            if (!catchingUpRef.current) {
              console.info(`[ai-view] drift catch-up engaging (lag ${lagBefore.toFixed(1)}s -> ${lag.toFixed(1)}s) — playbackRate ${DRIFT_CATCHUP_RATE}`);
              catchingUpRef.current = true;
              snapCountRef.current += 1;
            }
            video.playbackRate = DRIFT_CATCHUP_RATE;
          } else if (catchingUpRef.current) {
            console.info(`[ai-view] drift caught up (lag ${lag.toFixed(1)}s) — playbackRate 1.0`);
            catchingUpRef.current = false;
            video.playbackRate = 1.0;
          }
        }
        driftCheckRef.current = { wallMs: now, videoTime: video.currentTime };
      }, DRIFT_CHECK_MS);

      // Stats readout — same getStats()-polling shape as LiveWebrtcVideo's
      // overlay, computing per-interval deltas rather than lifetime averages
      // (a lifetime average of jitterBufferDelay/EmittedCount would smear an
      // early spike across the whole session instead of showing what's
      // happening right now).
      statsTimer = window.setInterval(async () => {
        if (cancelled || !pc) return;
        try {
          const report = await pc.getStats();
          const stats = Array.from(report.values()) as Array<Record<string, unknown>>;
          const inbound = stats.find((r) => r.type === 'inbound-rtp' && r.kind === 'video') as
            | Record<string, number> | undefined;
          if (!inbound) return;
          const nowMs = Date.now();

          let fps: number | null = null;
          if (prevFramesDecodedRef.current != null && prevFramesAtMsRef.current != null) {
            const dtSec = (nowMs - prevFramesAtMsRef.current) / 1000;
            if (dtSec > 0) fps = Math.max(0, (inbound.framesDecoded - prevFramesDecodedRef.current) / dtSec);
          }
          prevFramesDecodedRef.current = inbound.framesDecoded ?? null;
          prevFramesAtMsRef.current = nowMs;

          let kbps: number | null = null;
          if (prevBytesReceivedRef.current != null && typeof inbound.bytesReceived === 'number') {
            const deltaBytes = inbound.bytesReceived - prevBytesReceivedRef.current;
            kbps = Math.max(0, (deltaBytes * 8) / 1000 / (STATS_POLL_MS / 1000));
          }
          prevBytesReceivedRef.current = typeof inbound.bytesReceived === 'number' ? inbound.bytesReceived : null;

          let jitterBufferMsNow: number | null = null;
          if (
            prevJitterBufferDelayRef.current != null && prevJitterBufferEmittedRef.current != null &&
            typeof inbound.jitterBufferDelay === 'number' && typeof inbound.jitterBufferEmittedCount === 'number'
          ) {
            const deltaDelay = inbound.jitterBufferDelay - prevJitterBufferDelayRef.current;
            const deltaEmitted = inbound.jitterBufferEmittedCount - prevJitterBufferEmittedRef.current;
            if (deltaEmitted > 0) jitterBufferMsNow = (deltaDelay / deltaEmitted) * 1000;
          }
          prevJitterBufferDelayRef.current = typeof inbound.jitterBufferDelay === 'number' ? inbound.jitterBufferDelay : null;
          prevJitterBufferEmittedRef.current = typeof inbound.jitterBufferEmittedCount === 'number' ? inbound.jitterBufferEmittedCount : null;

          const jitterMs = typeof inbound.jitter === 'number' ? inbound.jitter * 1000 : null;
          const packetsLost = typeof inbound.packetsLost === 'number' ? inbound.packetsLost : null;

          const detSamples = detLatencySamplesRef.current;
          const detLatAvgMs = detSamples.length ? detSamples.reduce((a, b) => a + b, 0) / detSamples.length : null;

          setStatsText(
            `${fps != null ? fps.toFixed(0) : '—'} fps`
            + ` · ${kbps != null ? kbps.toFixed(0) : '—'} kbps`
            + ` · loss ${packetsLost ?? '—'}`
            + ` · jitter ${jitterMs != null ? jitterMs.toFixed(0) : '—'}ms`
            + ` · buf ${jitterBufferMsNow != null ? jitterBufferMsNow.toFixed(0) : '—'}ms`
            + ` · lag ${cumulativeLagSecRef.current.toFixed(1)}s`
            + (detLatAvgMs != null ? ` · det-lat ${detLatAvgMs.toFixed(0)}ms` : '')
            + ` · snaps ${snapCountRef.current}`,
          );
        } catch { /* ignore — try again next tick */ }
      }, STATS_POLL_MS);
    })().catch(() => {
      if (!cancelled) { setWhepState('error'); setErrorMsg((m) => m ?? UNREACHABLE_MSG); }
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (driftTimer) window.clearInterval(driftTimer);
      if (statsTimer) window.clearInterval(statsTimer);
      if (sessionUrl) deleteWhepSession(sessionUrl);
      pc?.close();
    };
  }, [streamName, epoch]);

  // Resolve the stream's current stream_id, then connect the detection WS and msgpack-decode frames.
  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pollTimer: number | null = null;

    const clearBuffer = () => {
      bufferRef.current = [];
      lastEpochRef.current = null;
      lastFrameSeqRef.current = null;
    };

    const connectWs = (urls: string[], idx: number) => {
      if (cancelled) return;
      if (idx >= urls.length) { setWsState('error'); setErrorMsg((m) => m ?? UNREACHABLE_MSG); return; }
      const socket = new WebSocket(urls[idx], ['artemis', AI_WS_TOKEN]);
      socket.binaryType = 'arraybuffer';
      let openedOnce = false;
      socket.onopen = () => {
        openedOnce = true;
        if (cancelled) return;
        setWsState('open');
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
        if (!streamIdRef.current || m.body.stream_id !== streamIdRef.current) return;

        const body = m.body;
        if (lastEpochRef.current !== null && body.pipeline_epoch !== lastEpochRef.current) {
          clearBuffer();
        } else if (
          lastFrameSeqRef.current !== null &&
          body.frame_seq < lastFrameSeqRef.current - FRAME_SEQ_BACKWARD_JUMP
        ) {
          clearBuffer();
        }
        lastEpochRef.current = body.pipeline_epoch;
        lastFrameSeqRef.current = body.frame_seq;
        bufferRef.current.push(body);
        if (bufferRef.current.length > DETECTION_BUFFER_SIZE) bufferRef.current.shift();
        detCountRef.current += 1;

        // Engine->browser metadata latency — only ever populated if a message
        // actually carries ingest_ts_ns (not part of the documented schema as
        // of this writing; see DetectionBody). Nanoseconds since epoch, so
        // converted to ms before comparing against Date.now().
        if (body.ingest_ts_ns != null) {
          const ingestMs = Number(body.ingest_ts_ns) / 1e6;
          if (Number.isFinite(ingestMs)) {
            const samples = detLatencySamplesRef.current;
            samples.push(Date.now() - ingestMs);
            if (samples.length > DET_LATENCY_WINDOW) samples.shift();
          }
        }
      };
      socket.onclose = () => {
        if (cancelled) return;
        if (!openedOnce) { connectWs(urls, idx + 1); return; }
        setWsState('error');
        setErrorMsg((m) => m ?? UNREACHABLE_MSG);
      };
      ws = socket;
    };

    (async () => {
      try {
        const res = await fetch(aiStreamByNameUrl(streamName), { headers: { 'X-Owner': DEFAULT_OWNER } });
        if (!res.ok) throw new Error(`stream lookup HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        streamIdRef.current = data.stream_id;

        const pollState = async () => {
          try {
            const r = await fetch(`http://${AI_ENGINE_HOST}:${AI_ENGINE_API_PORT}/v1/streams/${data.stream_id}`, {
              headers: { 'X-Owner': DEFAULT_OWNER },
            });
            if (r.ok) {
              const detail = await r.json();
              if (!cancelled) setStreamEngineState(detail?.state ?? null);
            }
          } catch { /* best-effort — status line just omits it */ }
        };
        pollState();
        pollTimer = window.setInterval(pollState, STREAM_STATE_POLL_MS);

        connectWs(aiWsUrls(), 0);
      } catch {
        if (!cancelled) { setWsState('error'); setErrorMsg(UNREACHABLE_MSG); }
      }
    })();

    const detTimer = window.setInterval(() => {
      if (cancelled) return;
      setDetPerSec(detCountRef.current);
      detCountRef.current = 0;
    }, 1000);

    return () => {
      cancelled = true;
      ws?.close();
      if (pollTimer) window.clearInterval(pollTimer);
      window.clearInterval(detTimer);
    };
  }, [streamName]);

  // Draw loop: canvas overlay sized to the video's rendered box each frame.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.videoWidth && video.videoHeight) {
        const boxW = video.clientWidth;
        const boxH = video.clientHeight;
        if (canvas.width !== boxW) canvas.width = boxW;
        if (canvas.height !== boxH) canvas.height = boxH;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, boxW, boxH);
          // v1 simplification: always draw the most recently buffered
          // detection set rather than matching frame_seq to the video
          // frame currently on screen. Real calibration would need a
          // shared clock between the engine's detector and the browser's
          // decode pipeline; nearest-recent is a simpler, honest choice
          // for a diagnostic overlay — it can visibly lag a live scene by
          // up to one detection interval, and that's fine here.
          const latest = bufferRef.current[bufferRef.current.length - 1];
          if (latest) {
            const scale = Math.min(boxW / video.videoWidth, boxH / video.videoHeight);
            const dispW = video.videoWidth * scale;
            const dispH = video.videoHeight * scale;
            const offsetX = (boxW - dispW) / 2;
            const offsetY = (boxH - dispH) / 2;
            const sx = dispW / latest.source_width;
            const sy = dispH / latest.source_height;
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = colors.accentText;
            ctx.font = `600 11px ${font.mono}`;
            for (const d of latest.detections) {
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
              ctx.fillStyle = colors.accentText;
              ctx.fillText(label, rx + 4, Math.max(11, ry - 4));
            }
          }
        }
      }
      raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const wsLabel = wsState === 'open' ? 'WS OPEN' : wsState === 'error' ? 'WS ERROR' : 'WS CONNECTING…';
  const whepLabel = whepState === 'open' ? 'VIDEO OK' : whepState === 'error' ? 'VIDEO ERROR' : 'VIDEO CONNECTING…';
  const fatal = whepState === 'error' && wsState === 'error';

  const panelStyle = fullscreen
    ? undefined
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };

  return (
    <div className={`ai-view-panel${fullscreen ? ' fullscreen' : ''}`} style={panelStyle}>
      <div
        className="ai-view-head"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
        onLostPointerCapture={endHeaderDrag}
      >
        <span>{cameraLabel} · AI VIEW</span>
        <div className="ai-view-head-actions">
          <button
            className="ai-view-fullscreen-btn"
            onClick={() => setFullscreen((f) => !f)}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4" />
              </svg>
            )}
          </button>
          <button className="ai-view-close" onClick={onClose} aria-label="Close AI view" title="Close (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div className="ai-view-stage">
        <video ref={videoRef} className="ai-view-video" muted playsInline autoPlay />
        <canvas ref={canvasRef} className="ai-view-canvas" />
        {fatal && <div className="ai-view-error">{errorMsg ?? UNREACHABLE_MSG}</div>}
        <div className="ai-view-status">
          <span>{whepLabel}</span>
          <span>{wsLabel}</span>
          <span>{detPerSec.toFixed(0)} det/s</span>
          {streamEngineState && <span>ENGINE {streamEngineState.toUpperCase()}</span>}
        </div>
        {whepState === 'open' && statsText && <div className="ai-view-stats">{statsText}</div>}
      </div>
      {!fullscreen && (
        <div
          className="ai-view-resize-grip"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={endGripResize}
          onPointerCancel={endGripResize}
          onLostPointerCapture={endGripResize}
        />
      )}
    </div>
  );
}
