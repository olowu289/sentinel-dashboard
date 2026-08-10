import { useEffect, useRef, useState } from 'react';
import LiveHlsVideo from './LiveHlsVideo';
import LiveWebrtcVideo from './LiveWebrtcVideo';
import { postWhepOffer, deleteWhepSession } from '../webrtcApi';
import type { TileStats } from '../liveStats';

interface Props {
  /** Platform API HLS playlist URL — compatibility fallback. */
  hlsUrl?: string;
  /** Platform API WHEP create-session URL — tried first when present. */
  whepUrl?: string;
  apiKey: string;
  streamReady?: boolean;
  ngrok?: boolean;
  /** Increment to snap HLS playback to the live edge (e.g. on PTZ). Ignored in webrtc mode. */
  syncLiveTick?: number;
  /** Called on every stats sample from whichever transport is currently playing. */
  onStats?: (s: TileStats) => void;
  /** True when whepUrl points directly at the Jetson's own MediaMTX (dashboard
   * "local video mode") rather than the hub/platform. Connection logic is
   * identical either way — this only changes the exhausted-retries message,
   * since "no stream configured" is misleading for a real connectivity
   * failure (the PC likely isn't on the camera segment). */
  localMode?: boolean;
}

type Mode = 'webrtc' | 'hls' | 'none';

function initialMode(whepUrl?: string, hlsUrl?: string): Mode {
  if (whepUrl) return 'webrtc';
  if (hlsUrl) return 'hls';
  return 'none';
}

/**
 * A flaky upstream (e.g. the tower's own RTSP source blipping every minute or two)
 * kills the active WebRTC session on the MediaMTX side just as often as it kills
 * HLS — but unlike HLS, a fresh WebRTC session is cheap to re-establish and carries
 * no buffer to rebuild. Retry a few times before conceding to HLS's deep NVR buffer.
 * Threshold is deliberately patient (5, not 3): a transient single failure must
 * never reach the fallback path, and worst case (5 attempts x up to 15s connect
 * timeout each, plus backoff between them) still lands inside a 60-90s
 * time-to-fallback budget.
 */
const MAX_WEBRTC_RETRIES = 5;
const WEBRTC_RETRY_BACKOFF_MS = 2000;

/**
 * How often to run a background WebRTC probe while parked on HLS fallback.
 * Unlike the old cooldown timer this replaces, this never touches the visible
 * player — it's an entirely separate, invisible test connection. Only a
 * confirmed success (real connection + real decoded frames) swaps the visible
 * tile back to WebRTC.
 */
const PROBE_INTERVAL_MS = 45000;
const PROBE_ICE_GATHER_TIMEOUT_MS = 3500;
const PROBE_CONNECT_TIMEOUT_MS = 8000;
/** After 'connected', how long to wait for the decoder to actually produce frames. */
const PROBE_FRAMES_TIMEOUT_MS = 4000;

const PROBE_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Negotiates a real WHEP session and waits for actual decoded frames, entirely
 * off-screen (a detached <video>, never attached to the DOM) — lets LiveVideo
 * confirm WebRTC has recovered without ever touching the visible, currently-
 * playing HLS player. Single attempt: no stream_starting retry loop here (the
 * caller already re-runs this every PROBE_INTERVAL_MS, which absorbs that).
 */
async function probeWebrtc(
  whepUrl: string,
  apiKey: string,
  ngrok: boolean,
  cancelledRef: { current: boolean },
): Promise<boolean> {
  const pc = new RTCPeerConnection({ iceServers: PROBE_ICE_SERVERS });
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  let sessionUrl: string | undefined;

  const cleanup = () => {
    pc.close();
    if (sessionUrl) void deleteWhepSession({ apiKey, ngrok }, sessionUrl);
  };

  try {
    pc.ontrack = (ev) => { video.srcObject = ev.streams[0]; };
    pc.addTransceiver('video', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Non-trickle: same gather-then-send-one-offer approach as the visible player.
    await Promise.race([
      new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        const check = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', check);
      }),
      new Promise<void>((resolve) => window.setTimeout(resolve, PROBE_ICE_GATHER_TIMEOUT_MS)),
    ]);
    if (cancelledRef.current) { cleanup(); return false; }

    const offerSdp = pc.localDescription!.sdp;
    const session = await postWhepOffer({ apiKey, ngrok }, whepUrl, offerSdp);
    sessionUrl = session.sessionUrl;
    if (cancelledRef.current) { cleanup(); return false; }

    await pc.setRemoteDescription({ type: 'answer', sdp: session.answerSdp });
    void video.play().catch(() => { /* detached/offscreen — autoplay policy irrelevant here */ });

    const connected = await Promise.race([
      new Promise<boolean>((resolve) => {
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') resolve(true);
          else if (pc.connectionState === 'failed') resolve(false);
        };
      }),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), PROBE_CONNECT_TIMEOUT_MS)),
    ]);
    if (!connected || cancelledRef.current) { cleanup(); return false; }

    // "Connected" alone isn't proof the stream actually works — confirm the
    // decoder is producing real frames before reporting success.
    const framesDecoding = await Promise.race([
      new Promise<boolean>((resolve) => {
        const check = async () => {
          if (cancelledRef.current) { resolve(false); return; }
          try {
            const report = await pc.getStats();
            const inbound = Array.from(report.values()).find(
              (r) => (r as { type?: string }).type === 'inbound-rtp' && (r as { kind?: string }).kind === 'video',
            ) as { framesDecoded?: number } | undefined;
            if (inbound && (inbound.framesDecoded ?? 0) > 0) { resolve(true); return; }
          } catch { /* try again next tick */ }
          window.setTimeout(check, 500);
        };
        void check();
      }),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), PROBE_FRAMES_TIMEOUT_MS)),
    ]);

    cleanup();
    return framesDecoding && !cancelledRef.current;
  } catch {
    cleanup();
    return false;
  }
}

/**
 * Picks the best available live-video transport for one camera tile: tries WebRTC
 * (sub-second latency) first when a whepUrl is available. A WebRTC failure retries
 * WebRTC itself first (see constants above) since the usual cause is a transient
 * upstream blip, not a lasting incompatibility; only after repeated failures does
 * it fall back to HLS (buffered, ~5-12s, but works everywhere — see LiveHlsVideo's
 * degraded-mode badge). A fresh mount (camera switch) always retries WebRTC first.
 *
 * While parked on HLS, WebRTC is never blindly retried on the visible player —
 * a background probe (see probeWebrtc above) tests it invisibly every
 * PROBE_INTERVAL_MS, and only a confirmed-working probe swaps the tile back.
 * The previously-playing HLS stream is never torn down just to test WebRTC.
 */
export default function LiveVideo({ hlsUrl, whepUrl, apiKey, streamReady = true, ngrok = false, syncLiveTick, onStats, localMode = false }: Props) {
  const [mode, setMode] = useState<Mode>(() => initialMode(whepUrl, hlsUrl));
  const [webrtcKey, setWebrtcKey] = useState(0);
  const attemptsRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const probeInFlightRef = useRef(false);
  const probeCancelledRef = useRef({ current: false });

  useEffect(() => {
    attemptsRef.current = 0;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setMode(initialMode(whepUrl, hlsUrl));
    setWebrtcKey((k) => k + 1);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [whepUrl, hlsUrl]);

  const handleWebrtcFatal = () => {
    attemptsRef.current += 1;
    console.info(`[live] webrtc failed ${attemptsRef.current}/${MAX_WEBRTC_RETRIES}`);
    if (attemptsRef.current <= MAX_WEBRTC_RETRIES) {
      timerRef.current = window.setTimeout(() => {
        setWebrtcKey((k) => k + 1);
      }, WEBRTC_RETRY_BACKOFF_MS);
      return;
    }
    console.info('[live] falling back to HLS');
    setMode(hlsUrl ? 'hls' : 'none');
  };

  useEffect(() => {
    if (mode !== 'hls' || !whepUrl) return;

    const runProbe = () => {
      if (document.visibilityState !== 'visible' || probeInFlightRef.current) return;
      probeInFlightRef.current = true;
      const cancelledRef = { current: false };
      probeCancelledRef.current = cancelledRef;
      probeWebrtc(whepUrl, apiKey, ngrok, cancelledRef)
        .then((ok) => {
          probeInFlightRef.current = false;
          if (cancelledRef.current || !ok) return;
          console.info('[live] probe succeeded, swapping back to webrtc');
          attemptsRef.current = 0;
          setWebrtcKey((k) => k + 1);
          setMode('webrtc');
        })
        .catch(() => { probeInFlightRef.current = false; });
    };

    const probeTimer = window.setInterval(runProbe, PROBE_INTERVAL_MS);
    return () => {
      window.clearInterval(probeTimer);
      probeCancelledRef.current.current = true;
    };
  }, [mode, whepUrl, apiKey, ngrok]);

  if (mode === 'webrtc' && whepUrl) {
    return (
      <LiveWebrtcVideo
        key={webrtcKey}
        whepUrl={whepUrl}
        apiKey={apiKey}
        ngrok={ngrok}
        streamReady={streamReady}
        onFatalError={handleWebrtcFatal}
        onConnected={() => {
          attemptsRef.current = 0;
          console.info('[live] webrtc connected');
        }}
        onStats={onStats}
      />
    );
  }

  if (mode === 'hls' && hlsUrl) {
    return (
      <LiveHlsVideo
        hlsUrl={hlsUrl}
        apiKey={apiKey}
        streamReady={streamReady}
        ngrok={ngrok}
        syncLiveTick={syncLiveTick}
        onStats={onStats}
      />
    );
  }

  return (
    <div className="cam-video-wrap">
      <div className="cam-note">
        {localMode ? 'local source unreachable — switch to platform mode' : 'no stream configured'}
      </div>
    </div>
  );
}
