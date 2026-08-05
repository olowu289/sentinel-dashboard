import { useEffect, useRef, useState } from 'react';
import { postWhepOffer, deleteWhepSession } from '../webrtcApi';

interface Props {
  /** Platform API WHEP create-session URL (POST an SDP offer here). */
  whepUrl: string;
  apiKey: string;
  /** True when control plane URL is ngrok (needs browser warning skip header). */
  ngrok?: boolean;
  /** When false, tear down (camera offline / tower down). */
  streamReady?: boolean;
  /** Called once when this attempt is unrecoverable — parent falls back to HLS. */
  onFatalError: (err?: unknown) => void;
  /** Called once when this session actually reaches connectionState 'connected'. */
  onConnected?: () => void;
}

/** Non-trickle ICE: wait this long for gathering to finish before sending whatever we have. */
const ICE_GATHER_TIMEOUT_MS = 3500;
/** Overall time budget to reach connectionState 'connected' before giving up. */
const CONNECT_TIMEOUT_MS = 15000;
/**
 * The backend returns 503 stream_starting while MediaMTX is still spinning up the
 * on-demand RTSP pull for a camera path that was just created — it's not a failure,
 * it's "ask again in a moment" (same contract the HLS path already relies on).
 * Retry a handful of times before treating it as fatal.
 */
const STREAM_STARTING_MAX_RETRIES = 10;
const STREAM_STARTING_RETRY_DELAY_MS = 2000;

/** Estimated seconds of accumulated lag before we tear down and reconnect fresh. */
const DRIFT_RESYNC_THRESHOLD_SEC = 4;
/** Don't resync a session that only just connected — give it a chance to settle. */
const DRIFT_MIN_SESSION_AGE_MS = 20000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** How often to sample pc.getStats() for the on-screen readout. */
const STATS_POLL_MS = 2000;

export interface WebrtcStatsSample {
  t: number;
  /** Avg receive-side jitter buffer delay per frame, ms — closest standard stat to "latency". */
  jitterBufferMs: number | null;
  packetsLost: number | null;
  lossPct: number | null;
  /** Standard WebRTC stats fields — directly the "it pauses then jumps" symptom. */
  freezeCount: number;
  totalFreezesDurationSec: number;
  pauseCount: number;
  totalPausesDurationSec: number;
  framesDropped: number;
  framesDecoded: number;
}

declare global {
  interface Window {
    __sentinelWebrtcMetrics?: {
      samples: WebrtcStatsSample[];
      last: WebrtcStatsSample | null;
    };
  }
}

/**
 * Client-side STUN only — the hub doesn't need one (its public IP is already baked
 * into webrtcAdditionalHosts server-side), but the browser is almost always behind
 * its own NAT and needs a reflexive candidate to put in its offer. Two independent
 * providers so one outage doesn't matter; no TURN for v1 — a network that blocks
 * WebRTC entirely just falls back to HLS, which is what that fallback is for.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Low-latency live video via WHEP. Gathers ICE to completion (or a timeout) and sends
 * one offer — no PATCH/trickle round trip (see webrtcApi.ts). Falls back to HLS (via
 * the LiveVideo wrapper) on any unrecoverable failure or connect timeout.
 */
export default function LiveWebrtcVideo({ whepUrl, apiKey, ngrok = false, streamReady = true, onFatalError, onConnected }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState('connecting…');
  const [playing, setPlaying] = useState(false);
  const [statsText, setStatsText] = useState('');
  /** Bumped by the drift watchdog to force a fresh session without going through
   * the parent's HLS circuit-breaker — a resync is not a failure. */
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    setPlaying(false);
    setNote(streamReady ? 'connecting…' : 'camera offline');
  }, [whepUrl, streamReady]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlaying = () => { setPlaying(true); setNote(''); };
    const onWaiting = () => setNote('buffering…');
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
    };
  }, []);

  useEffect(() => {
    if (!whepUrl) return;
    // Deliberately NOT gated on `streamReady` and NOT a dependency below: it's a
    // polled proxy signal (tower /streams check, every few seconds) that flickers
    // transiently even when the tower is fine. Reacting to it here would tear
    // down and fully renegotiate a healthy WebRTC session on every flicker — far
    // more disruptive than an HLS reattach, and the actual cause of "reconnect
    // every ~30s" stutter observed in testing. If the camera is genuinely offline,
    // this attempt just fails/times out on its own and the LiveVideo wrapper
    // falls back to HLS — no need for a second, flakier readiness gate on top.

    // Shared across the async negotiation IIFE and this effect's own cleanup —
    // whichever runs last is the one that actually tears the session down, so an
    // unmount racing an in-flight POST (React 18 StrictMode's double-invoke in dev,
    // or a real fast camera switch in prod) never leaks a WHEP session.
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;
    let connectTimer: number | undefined;
    let statsTimer: number | undefined;
    let connectedAtMs: number | null = null;
    let baselineFreezesSec: number | null = null;
    let resyncTriggered = false;

    const fail = (err?: unknown) => {
      if (cancelled) return;
      cancelled = true;
      if (connectTimer) window.clearTimeout(connectTimer);
      if (statsTimer) window.clearInterval(statsTimer);
      pc?.close();
      onFatalError(err);
    };

    // Standard WebRTC stats — jitterBufferDelay/jitterBufferEmittedCount is the
    // closest thing to a real "latency" number this API exposes; freezeCount/
    // totalFreezesDuration and pauseCount/totalPausesDuration are literally the
    // "it pauses then jumps" symptom, reported by the browser itself rather than
    // guessed at from watching the picture.
    const pollStats = async () => {
      if (cancelled || !pc) return;
      try {
        const report = await pc.getStats();
        const stats = Array.from(report.values()) as Array<Record<string, unknown>>;
        const inbound = stats.find((r) => r.type === 'inbound-rtp' && r.kind === 'video') as
          | Record<string, number>
          | undefined;
        if (!inbound || cancelled) return;
        const jitterBufferMs = inbound.jitterBufferEmittedCount
          ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000
          : null;
        const totalPkts = (inbound.packetsLost ?? 0) + (inbound.packetsReceived ?? 0);
        const lossPct = totalPkts > 0 ? ((inbound.packetsLost ?? 0) / totalPkts) * 100 : null;
        const sample: WebrtcStatsSample = {
          t: Date.now(),
          jitterBufferMs,
          packetsLost: inbound.packetsLost ?? null,
          lossPct,
          freezeCount: inbound.freezeCount ?? 0,
          totalFreezesDurationSec: inbound.totalFreezesDuration ?? 0,
          pauseCount: inbound.pauseCount ?? 0,
          totalPausesDurationSec: inbound.totalPausesDuration ?? 0,
          framesDropped: inbound.framesDropped ?? 0,
          framesDecoded: inbound.framesDecoded ?? 0,
        };
        const bucket = window.__sentinelWebrtcMetrics ?? { samples: [], last: null };
        bucket.samples.push(sample);
        if (bucket.samples.length > 120) bucket.samples.shift();
        bucket.last = sample;
        window.__sentinelWebrtcMetrics = bucket;

        // Drift watchdog: freezes plus current jitter buffer depth as a rough estimate
        // of how far behind live we've drifted. A big number here is the "smooth but
        // delayed" symptom accumulating quietly — tear down and reconnect fresh rather
        // than let it grow unbounded. Not a failure, so onFatalError is never called.
        let driftText = '';
        if (connectedAtMs != null && !resyncTriggered) {
          if (baselineFreezesSec === null) baselineFreezesSec = sample.totalFreezesDurationSec;
          const driftSec = (sample.totalFreezesDurationSec - baselineFreezesSec)
            + (jitterBufferMs != null ? jitterBufferMs / 1000 : 0);
          driftText = ` · drift ~${driftSec.toFixed(1)}s`;
          const sessionAgeMs = Date.now() - connectedAtMs;
          if (driftSec > DRIFT_RESYNC_THRESHOLD_SEC && sessionAgeMs >= DRIFT_MIN_SESSION_AGE_MS) {
            resyncTriggered = true;
            console.info(`[webrtc] drift ~${driftSec.toFixed(1)}s — resyncing to live`);
            setEpoch((e) => e + 1);
          }
        }

        setStatsText(
          `jitter ${jitterBufferMs != null ? `${jitterBufferMs.toFixed(0)}ms` : '—'}`
          + ` · loss ${lossPct != null ? `${lossPct.toFixed(1)}%` : '—'}`
          + ` · freezes ${sample.freezeCount} (${sample.totalFreezesDurationSec.toFixed(1)}s)`
          + ` · pauses ${sample.pauseCount} (${sample.totalPausesDurationSec.toFixed(1)}s)`
          + driftText,
        );
      } catch { /* ignore — try again next tick */ }
    };

    (async () => {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.ontrack = (ev) => {
        if (cancelled) return;
        const video = videoRef.current;
        if (video) video.srcObject = ev.streams[0];
      };

      pc.onconnectionstatechange = () => {
        if (cancelled || !pc) return;
        if (pc.connectionState === 'connected') {
          if (connectTimer) { window.clearTimeout(connectTimer); connectTimer = undefined; }
          connectedAtMs = Date.now();
          onConnected?.();
        } else if (pc.connectionState === 'failed') {
          fail(new Error('webrtc connection failed'));
        }
      };

      connectTimer = window.setTimeout(() => fail(new Error('webrtc connect timeout')), CONNECT_TIMEOUT_MS);

      pc.addTransceiver('video', { direction: 'recvonly' });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Non-trickle: wait for full ICE gathering (or a timeout), then send one offer.
      await Promise.race([
        new Promise<void>((resolve) => {
          if (pc!.iceGatheringState === 'complete') { resolve(); return; }
          const check = () => {
            if (pc!.iceGatheringState === 'complete') {
              pc!.removeEventListener('icegatheringstatechange', check);
              resolve();
            }
          };
          pc!.addEventListener('icegatheringstatechange', check);
        }),
        new Promise<void>((resolve) => { window.setTimeout(resolve, ICE_GATHER_TIMEOUT_MS); }),
      ]);
      if (cancelled) return;

      // pc.localDescription.sdp, not the original `offer` object — the browser
      // mutates it in place as candidates are discovered during the race above.
      const offerSdp = pc.localDescription!.sdp;
      let session: { answerSdp: string; sessionUrl: string } | undefined;
      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          session = await postWhepOffer({ apiKey, ngrok }, whepUrl, offerSdp);
          break;
        } catch (err) {
          const code = (err as { code?: string } | undefined)?.code;
          if (code === 'stream_starting' && attempt < STREAM_STARTING_MAX_RETRIES) {
            await delay(STREAM_STARTING_RETRY_DELAY_MS);
            continue;
          }
          throw err;
        }
      }
      if (!session) return; // cancelled before any attempt ever succeeded — nothing to clean up
      if (cancelled) {
        // Succeeded right as we were torn down (unmount/camera-switch race) — the
        // returned cleanup below already ran and had no sessionUrl to delete yet,
        // so this branch is the one responsible for tearing down this session.
        void deleteWhepSession({ apiKey, ngrok }, session.sessionUrl);
        return;
      }
      sessionUrl = session.sessionUrl;
      await pc.setRemoteDescription({ type: 'answer', sdp: session.answerSdp });
      if (cancelled) return;

      // Hint a deeper jitter buffer (ms) to the decoder — not all browsers support
      // this property yet, hence the feature check and cast.
      for (const receiver of pc.getReceivers()) {
        if (receiver.track.kind !== 'video') continue;
        try {
          if ('jitterBufferTarget' in receiver) {
            (receiver as unknown as { jitterBufferTarget: number }).jitterBufferTarget = 250;
          }
        } catch { /* not supported in this browser — fine, it's just a hint */ }
      }

      statsTimer = window.setInterval(pollStats, STATS_POLL_MS);
    })().catch((err) => fail(err));

    return () => {
      cancelled = true;
      if (connectTimer) window.clearTimeout(connectTimer);
      if (statsTimer) window.clearInterval(statsTimer);
      if (sessionUrl) void deleteWhepSession({ apiKey, ngrok }, sessionUrl);
      pc?.close();
    };
    // apiKey/ngrok/streamReady intentionally excluded — see comment above.
    // epoch is included on purpose: the drift watchdog bumps it to force this
    // effect to tear down and rebuild a fresh session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whepUrl, epoch]);

  return (
    <div className="cam-video-wrap">
      <video ref={videoRef} className="cam-video" muted playsInline autoPlay />
      {!playing && <div className="cam-note">{note}</div>}
      {playing && statsText && <div className="cam-webrtc-stats">{statsText}</div>}
    </div>
  );
}
