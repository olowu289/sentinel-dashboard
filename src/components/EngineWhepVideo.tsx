import { useEffect, useRef, useState } from 'react';
import { postWhepOffer, deleteWhepSession } from '../webrtcApi';

interface Props {
  /** Perception Engine's own MediaMTX WHEP create-session URL (see aiConfig.ts's aiWhepUrl). */
  whepUrl: string;
  /** Called once when this attempt is unrecoverable — parent shows "engine unreachable". */
  onFatalError: (err?: unknown) => void;
  /** Called once when this session actually starts producing frames. */
  onConnected?: () => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const ICE_GATHER_TIMEOUT_MS = 3500;
const CONNECT_TIMEOUT_MS = 8000;
/** How often the drift guard checks currentTime advance vs wall clock. */
const DRIFT_CHECK_MS = 10000;
const DRIFT_CATCHUP_SEC = 2;
const DRIFT_HARD_RESYNC_SEC = 5;
const DRIFT_CATCHUP_RATE = 1.08;

/**
 * Minimal WHEP player for the Perception Engine's OWN MediaMTX (no auth —
 * postWhepOffer/deleteWhepSession send no auth header at all - the tower's
 * is empty, same as the dashboard's existing "local video mode"). Used for
 * the Mode A "AI Aligned View" comparison tile: this is the exact video the
 * engine's own detections are computed from, so pairing it with
 * AiOverlayCanvas gives pixel-correct alignment — no substream/mainstream
 * mismatch like cam1's normal (Mode B, cable) tile can have.
 *
 * Deliberately simpler than LiveWebrtcVideo: one connection attempt per
 * mount, no HLS fallback, no make-before-break background replacement —
 * toggling the tile off/on is the retry mechanism. Does carry over the two
 * latency cures the engine's WHEP endpoint specifically needed (learned
 * from the now-removed AiDetectionView's testing): a jitterBufferTarget
 * hint, and a periodic playbackRate catch-up/hard-resync drift watchdog.
 */
export default function EngineWhepVideo({ whepUrl, onFatalError, onConnected }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState('connecting…');
  const [playing, setPlaying] = useState(false);
  const driftCheckRef = useRef<{ wallMs: number; videoTime: number } | null>(null);
  const cumulativeLagSecRef = useRef(0);
  const catchingUpRef = useRef(false);
  /** Bumped only by a hard-resync — the same fresh-session fallback LiveWebrtcVideo/AiDetectionView use when playbackRate catch-up alone isn't closing the gap. */
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlaying = () => { setPlaying(true); setNote(''); onConnected?.(); };
    const onWaiting = () => setNote('buffering…');
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;
    let driftTimer: number | undefined;
    const connectTimer = window.setTimeout(() => {
      if (!cancelled) { cancelled = true; onFatalError(new Error('connect timeout')); }
    }, CONNECT_TIMEOUT_MS);

    (async () => {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pc.ontrack = (ev) => {
        if (!cancelled && videoRef.current) videoRef.current.srcObject = ev.streams[0];
      };
      pc.onconnectionstatechange = () => {
        if (cancelled || !pc) return;
        if (pc.connectionState === 'connected') {
          window.clearTimeout(connectTimer);
        } else if (pc.connectionState === 'failed') {
          cancelled = true;
          onFatalError(new Error('webrtc connection failed'));
        }
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

      const { answerSdp, sessionUrl: url } = await postWhepOffer(whepUrl, pc.localDescription!.sdp);
      if (cancelled) { void deleteWhepSession(url); pc.close(); return; }
      sessionUrl = url;
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (cancelled) return;

      for (const receiver of pc.getReceivers()) {
        if (receiver.track.kind !== 'video') continue;
        try {
          if ('jitterBufferTarget' in receiver) {
            (receiver as unknown as { jitterBufferTarget: number }).jitterBufferTarget = 250;
          }
        } catch { /* not supported in this browser — fine, it's just a hint */ }
      }

      driftCheckRef.current = null;
      cumulativeLagSecRef.current = 0;
      catchingUpRef.current = false;
      if (videoRef.current) videoRef.current.playbackRate = 1.0;

      driftTimer = window.setInterval(() => {
        const v = videoRef.current;
        if (!v || cancelled) return;
        const now = Date.now();
        const prev = driftCheckRef.current;
        if (prev) {
          const wallDeltaSec = (now - prev.wallMs) / 1000;
          const videoDeltaSec = v.currentTime - prev.videoTime;
          cumulativeLagSecRef.current += wallDeltaSec - videoDeltaSec;
          const lag = cumulativeLagSecRef.current;
          if (lag > DRIFT_HARD_RESYNC_SEC) {
            cumulativeLagSecRef.current = 0;
            catchingUpRef.current = false;
            v.playbackRate = 1.0;
            setEpoch((e) => e + 1);
            return;
          }
          if (lag > DRIFT_CATCHUP_SEC) {
            catchingUpRef.current = true;
            v.playbackRate = DRIFT_CATCHUP_RATE;
          } else if (catchingUpRef.current) {
            catchingUpRef.current = false;
            v.playbackRate = 1.0;
          }
        }
        driftCheckRef.current = { wallMs: now, videoTime: v.currentTime };
      }, DRIFT_CHECK_MS);
    })().catch((err) => {
      if (!cancelled) { cancelled = true; onFatalError(err); }
    });

    return () => {
      cancelled = true;
      window.clearTimeout(connectTimer);
      if (driftTimer) window.clearInterval(driftTimer);
      if (sessionUrl) void deleteWhepSession(sessionUrl);
      pc?.close();
    };
    // onFatalError/onConnected intentionally excluded — the parent passes a
    // fresh inline closure every render (same reasoning as LiveWebrtcVideo's
    // streamReady exclusion below); including it would tear
    // down and reconnect a healthy session on every unrelated parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whepUrl, epoch]);

  return (
    <div className="cam-video-wrap">
      <video ref={videoRef} className="cam-video" muted playsInline autoPlay />
      {!playing && <div className="cam-note">{note}</div>}
    </div>
  );
}
