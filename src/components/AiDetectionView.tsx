import { useEffect, useRef, useState } from 'react';
import { decode } from '@msgpack/msgpack';
import { colors, font } from '../tokens';
import {
  aiStreamByNameUrl, aiWhepUrl, aiWsUrls, AI_WS_TOKEN, AI_ENGINE_HOST, AI_ENGINE_API_PORT,
} from '../aiConfig';

/**
 * Fullscreen diagnostic viewer: direct WHEP video from the Perception
 * Engine's own MediaMTX + a msgpack detection-WS overlay. Deliberately
 * "dumb" compared to LiveWebrtcVideo — no make-before-break resync, no HLS
 * fallback, no stream-starting retry probes. Does borrow LiveWebrtcVideo's
 * two known latency cures: a jitterBufferTarget hint, and (a much cheaper
 * version of its drift watchdog) a periodic seek-to-live snap instead of
 * rebuilding the session. A LAN-reachability failure on either leg surfaces
 * as a plain message, never an infinite spinner.
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
/** How often the minimal drift guard checks currentTime advance vs wall clock. */
const DRIFT_CHECK_MS = 10000;
/** Cumulative lag (seconds) before we snap to the freshest buffered frame. */
const DRIFT_RESYNC_THRESHOLD_SEC = 3;

interface Detection { bbox: [number, number, number, number]; name: string; conf: number; }
interface DetectionBody {
  stream_id: string;
  pipeline_epoch: number;
  frame_seq: number;
  source_width: number;
  source_height: number;
  detections: Detection[];
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

  const bufferRef = useRef<DetectionBody[]>([]);
  const lastEpochRef = useRef<number | null>(null);
  const lastFrameSeqRef = useRef<number | null>(null);
  const detCountRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  /** Minimal drift guard state — see the WHEP effect below. */
  const driftCheckRef = useRef<{ wallMs: number; videoTime: number } | null>(null);
  const cumulativeLagSecRef = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // WHEP: minimal standalone player — no drift watchdog, no HLS fallback, no retry probes.
  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;
    let driftTimer: number | undefined;
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

      // Minimal drift guard — not LiveWebrtcVideo's full make-before-break
      // resync, just a periodic seek-to-live. WebRTC video elements normally
      // keep tiny buffers, but with a TCP ICE candidate pair and engine-side
      // queueing, playout can quietly fall behind; snapping straight to the
      // freshest buffered frame is far cheaper than rebuilding the session,
      // which is an acceptable trade for a diagnostic view.
      driftCheckRef.current = null;
      cumulativeLagSecRef.current = 0;
      driftTimer = window.setInterval(() => {
        const video = videoRef.current;
        if (!video || cancelled) return;
        const now = Date.now();
        const prev = driftCheckRef.current;
        if (prev) {
          const wallDeltaSec = (now - prev.wallMs) / 1000;
          const videoDeltaSec = video.currentTime - prev.videoTime;
          cumulativeLagSecRef.current += wallDeltaSec - videoDeltaSec;
          if (cumulativeLagSecRef.current > DRIFT_RESYNC_THRESHOLD_SEC) {
            if (video.buffered.length) {
              video.currentTime = video.buffered.end(video.buffered.length - 1) - 0.2;
            }
            cumulativeLagSecRef.current = 0;
          }
        }
        driftCheckRef.current = { wallMs: now, videoTime: video.currentTime };
      }, DRIFT_CHECK_MS);
    })().catch(() => {
      if (!cancelled) { setWhepState('error'); setErrorMsg((m) => m ?? UNREACHABLE_MSG); }
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (driftTimer) window.clearInterval(driftTimer);
      if (sessionUrl) deleteWhepSession(sessionUrl);
      pc?.close();
    };
  }, [streamName]);

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

  return (
    <div className="ai-view-backdrop" onClick={onClose}>
      <div className="ai-view" onClick={(e) => e.stopPropagation()}>
        <div className="ai-view-head">
          <span>{cameraLabel} · AI VIEW</span>
          <button className="ai-view-close" onClick={onClose} aria-label="Close AI view" title="Close (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
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
        </div>
      </div>
    </div>
  );
}
