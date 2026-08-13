import { useEffect, useRef, useState } from 'react';
import { postWhepOffer, deleteWhepSession } from '../webrtcApi';
import type { TileStats } from '../liveStats';

interface Props {
  /** WHEP create-session URL on the tower's own MediaMTX. */
  whepUrl: string;
  /** When false, tear down (camera offline / tower down). */
  streamReady?: boolean;
  /** Called once when this attempt is unrecoverable. There is nothing to
   * fall back to; the parent shows why instead. */
  onFatalError: (err?: unknown) => void;
  /** Called once when this session actually reaches connectionState 'connected'. */
  onConnected?: () => void;
  /** Called on every stats poll with fps/loss/drift for the tile footer. */
  onStats?: (s: TileStats) => void;
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

/** Estimated seconds of accumulated lag before we attempt a resync. */
const DRIFT_RESYNC_THRESHOLD_SEC = 2.5;
/** Don't resync a session that only just connected (or just swapped in) — give it a chance to settle. */
const DRIFT_MIN_SESSION_AGE_MS = 20000;
/**
 * Minimum time between resyncs, regardless of session boundaries (a resync
 * starts a fresh session, so this has to live outside the per-effect closure
 * to survive it — see lastResyncAtRef below). Counts from the moment a
 * make-before-break swap actually completes, not from when it was triggered.
 */
const DRIFT_MIN_RESYNC_INTERVAL_MS = 60000;
/**
 * Overall budget for a background replacement connection (negotiate + connect
 * + confirm frames decoding). If it hasn't swapped in by this point, abandon
 * it and fall back to the old visible-reconnect behavior for this attempt.
 */
const REPLACEMENT_TIMEOUT_MS = 20000;

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
    /** Keyed by whepUrl — one bucket per concurrently-playing tile, not a singleton. */
    __sentinelWebrtcMetrics?: Record<string, {
      samples: WebrtcStatsSample[];
      last: WebrtcStatsSample | null;
    }>;
  }
}

/**
/**
 * NO ICE SERVERS — host candidates only.
 *
 * The platform build listed Google and Cloudflare STUN because a remote
 * browser behind NAT needed a reflexive candidate to reach the hub. Neither
 * half of that holds here: the browser and MediaMTX are on the same switch,
 * so a host candidate IS the route.
 *
 * Removing them is not tidying. With STUN configured on an isolated network,
 * ICE gathering blocks waiting for replies that never come and only proceeds
 * when ICE_GATHER_TIMEOUT_MS expires — 3.5 SECONDS added to every camera
 * connection, on a product whose whole premise is latency. With nothing to
 * query, gathering completes almost immediately.
 *
 * It is also what lets this run air-gapped.
 */
/**
 * NO ICE SERVERS — host candidates only.
 *
 * The platform build listed Google and Cloudflare STUN because a remote
 * browser behind NAT needed a reflexive candidate to reach the hub. Neither
 * half of that holds here: the browser and MediaMTX are on the same switch,
 * so a host candidate IS the route.
 *
 * Removing them is not tidying. With STUN configured on an isolated network,
 * ICE gathering blocks waiting for replies that never come and only proceeds
 * when ICE_GATHER_TIMEOUT_MS expires — 3.5 SECONDS added to every camera
 * connection, on a product whose whole premise is latency. With nothing to
 * query, gathering completes almost immediately.
 *
 * It is also what lets this run air-gapped.
 */
const ICE_SERVERS: RTCIceServer[] = [];

/**
 * Non-trickle WHEP negotiation shared by both the primary connection and a
 * background replacement: gather ICE to completion (or a timeout), send one
 * offer, optionally retry on the backend's stream_starting contract. Returns
 * undefined if cancelled before any attempt ever succeeded.
 */
async function negotiateWhepSession(
  pc: RTCPeerConnection,
  whepUrl: string,
  isCancelled: () => boolean,
  retryStreamStarting: boolean,
): Promise<{ answerSdp: string; sessionUrl: string } | undefined> {
  pc.addTransceiver('video', { direction: 'recvonly' });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

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
    new Promise<void>((resolve) => { window.setTimeout(resolve, ICE_GATHER_TIMEOUT_MS); }),
  ]);
  if (isCancelled()) return undefined;

  // pc.localDescription.sdp, not the original `offer` object — the browser
  // mutates it in place as candidates are discovered during the race above.
  const offerSdp = pc.localDescription!.sdp;
  for (let attempt = 0; !isCancelled(); attempt += 1) {
    try {
      return await postWhepOffer(whepUrl, offerSdp);
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (retryStreamStarting && code === 'stream_starting' && attempt < STREAM_STARTING_MAX_RETRIES) {
        await delay(STREAM_STARTING_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  return undefined;
}

/**
 * Low-latency live video via WHEP. Gathers ICE to completion (or a timeout) and sends
 * one offer — no PATCH/trickle round trip (see webrtcApi.ts). Falls back to HLS (via
 * the LiveVideo wrapper) on any unrecoverable failure or connect timeout.
 */
export default function LiveWebrtcVideo({ whepUrl, streamReady = true, onFatalError, onConnected, onStats }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState('connecting…');
  const [playing, setPlaying] = useState(false);
  const [statsText, setStatsText] = useState('');
  /** Bumped only when a background replacement fails/times out — the old,
   * visible teardown/rebuild fallback for that case. A successful drift
   * resync never touches this; see attemptReplacement below. */
  const [epoch, setEpoch] = useState(0);
  /** Persists across resyncs (a swap reassigns pc/sessionUrl in place, so this
   * effect never actually restarts on a successful resync) so the minimum-
   * interval gate spans the whole component lifetime, not just one session. */
  const lastResyncAtRef = useRef(0);

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
    let prevDriftSec: number | null = null;
    let driftGrowthStreak = 0;
    /** For the tile-footer fps estimate: framesDecoded delta / time delta. */
    let prevFramesDecoded: number | null = null;
    let prevFramesAtMs: number | null = null;
    let replacementInFlight = false;
    /** Set while a background replacement is mid-flight; lets the effect's own
     * unmount cleanup abandon it too (closes its pc, deletes its session). */
    let activeReplacementCleanup: (() => void) | null = null;

    const fail = (err?: unknown) => {
      if (cancelled) return;
      cancelled = true;
      if (connectTimer) window.clearTimeout(connectTimer);
      if (statsTimer) window.clearInterval(statsTimer);
      pc?.close();
      onFatalError(err);
    };

    // Bound to whichever RTCPeerConnection is currently "the" connection — a
    // successful make-before-break swap reassigns `pc` and re-attaches this
    // same handler to the new one, so future real lifecycle events (e.g. a
    // later genuine failure) are handled identically to the original session.
    const onConnectionStateChange = () => {
      if (cancelled || !pc) return;
      if (pc.connectionState === 'connected') {
        if (connectTimer) { window.clearTimeout(connectTimer); connectTimer = undefined; }
        connectedAtMs = Date.now();
        onConnected?.();
      } else if (pc.connectionState === 'failed') {
        fail(new Error('webrtc connection failed'));
      }
    };

    /**
     * Make-before-break drift resync: negotiate a second, fully independent
     * connection in the background (same technique as LiveVideo's HLS-side
     * probe), and only once it's actually connected AND decoding real frames,
     * swap the visible <video>.srcObject to it — a single synchronous
     * assignment, no unmount, no black frame. Any failure or a >20s overall
     * timeout abandons the replacement and falls back to the old visible
     * teardown/rebuild (epoch bump) for this attempt.
     */
    const attemptReplacement = async (driftAtTriggerSec: number) => {
      if (replacementInFlight || cancelled) return;
      replacementInFlight = true;
      console.info(`[webrtc] replacement started (drift ~${driftAtTriggerSec.toFixed(1)}s)`);

      const newPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      let newStream: MediaStream | null = null;
      let newSessionUrl: string | undefined;
      let settled = false;
      let timeoutHandle: number | undefined;

      const abandon = (reason: string) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) window.clearTimeout(timeoutHandle);
        newPc.close();
        if (newSessionUrl) void deleteWhepSession(newSessionUrl);
        activeReplacementCleanup = null;
        replacementInFlight = false;
        if (cancelled) return; // unmounting/superseded — no visible fallback needed
        console.info(`[webrtc] replacement failed (${reason}) — falling back to visible reconnect`);
        setEpoch((e) => e + 1);
      };

      activeReplacementCleanup = () => {
        if (timeoutHandle) window.clearTimeout(timeoutHandle);
        newPc.close();
        if (newSessionUrl) void deleteWhepSession(newSessionUrl);
      };

      timeoutHandle = window.setTimeout(() => abandon('timeout'), REPLACEMENT_TIMEOUT_MS);
      newPc.ontrack = (ev) => { newStream = ev.streams[0]; };

      try {
        const session = await negotiateWhepSession(
          newPc, whepUrl, () => settled || cancelled, false,
        );
        if (!session || settled || cancelled) { abandon('negotiation did not complete'); return; }
        newSessionUrl = session.sessionUrl;

        await newPc.setRemoteDescription({ type: 'answer', sdp: session.answerSdp });
        if (settled || cancelled) { abandon('cancelled after answer'); return; }

        const connected = await new Promise<boolean>((resolve) => {
          newPc.onconnectionstatechange = () => {
            if (newPc.connectionState === 'connected') resolve(true);
            else if (newPc.connectionState === 'failed') resolve(false);
          };
        });
        if (!connected || settled || cancelled) { abandon('replacement connection failed'); return; }

        // "Connected" alone isn't proof the stream actually works — confirm
        // the decoder is producing real frames before treating it as ready.
        const framesOk = await new Promise<boolean>((resolve) => {
          const check = async () => {
            if (settled || cancelled) { resolve(false); return; }
            try {
              const report = await newPc.getStats();
              const inbound = Array.from(report.values()).find(
                (r) => (r as { type?: string }).type === 'inbound-rtp' && (r as { kind?: string }).kind === 'video',
              ) as { framesDecoded?: number } | undefined;
              if (inbound && (inbound.framesDecoded ?? 0) > 0) { resolve(true); return; }
            } catch { /* try again next tick */ }
            window.setTimeout(check, 300);
          };
          void check();
        });
        if (!framesOk || settled || cancelled || !newStream) {
          abandon(!newStream ? 'no track received' : 'replacement frames never decoded');
          return;
        }

        // --- Make-before-break swap: single synchronous srcObject assignment. ---
        settled = true;
        if (timeoutHandle) window.clearTimeout(timeoutHandle);

        const oldPc = pc;
        const oldSessionUrl = sessionUrl;

        if (videoRef.current) videoRef.current.srcObject = newStream;
        pc = newPc;
        sessionUrl = newSessionUrl;
        pc.onconnectionstatechange = onConnectionStateChange;
        connectedAtMs = Date.now();
        baselineFreezesSec = null;
        prevDriftSec = null;
        driftGrowthStreak = 0;
        prevFramesDecoded = null;
        prevFramesAtMs = null;
        lastResyncAtRef.current = Date.now();

        oldPc?.close();
        if (oldSessionUrl) void deleteWhepSession(oldSessionUrl);

        activeReplacementCleanup = null;
        replacementInFlight = false;
        console.info(`[webrtc] swap completed (drift ${driftAtTriggerSec.toFixed(1)}s -> ~0.0s)`);
      } catch (err) {
        abandon(err instanceof Error ? err.message : 'error');
      }
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
        const allMetrics = window.__sentinelWebrtcMetrics ?? {};
        const bucket = allMetrics[whepUrl] ?? { samples: [], last: null };
        bucket.samples.push(sample);
        if (bucket.samples.length > 120) bucket.samples.shift();
        bucket.last = sample;
        allMetrics[whepUrl] = bucket;
        window.__sentinelWebrtcMetrics = allMetrics;

        let fps: number | null = null;
        const nowMs = sample.t;
        if (prevFramesDecoded != null && prevFramesAtMs != null) {
          const dtSec = (nowMs - prevFramesAtMs) / 1000;
          if (dtSec > 0) fps = Math.max(0, (sample.framesDecoded - prevFramesDecoded) / dtSec);
        }
        prevFramesDecoded = sample.framesDecoded;
        prevFramesAtMs = nowMs;

        // Drift watchdog: freezes plus current jitter buffer depth as a rough estimate
        // of how far behind live we've drifted. A big number here is the "smooth but
        // delayed" symptom accumulating quietly — resync fresh rather than let it grow
        // unbounded. Not a failure, so onFatalError is never called. Calmer on purpose:
        // a *stable* drift on an otherwise healthy stream must not churn anything —
        // only a drift that's still growing across two consecutive polls, and only at
        // most once a minute (counted from the last successful swap), triggers a
        // background replacement attempt.
        let driftText = '';
        let driftSecForStats: number | null = null;
        if (connectedAtMs != null) {
          if (baselineFreezesSec === null) baselineFreezesSec = sample.totalFreezesDurationSec;
          const driftSec = (sample.totalFreezesDurationSec - baselineFreezesSec)
            + (jitterBufferMs != null ? jitterBufferMs / 1000 : 0);
          driftText = ` · drift ~${driftSec.toFixed(1)}s`;
          driftSecForStats = driftSec;

          const isGrowing = prevDriftSec != null && driftSec > prevDriftSec;
          driftGrowthStreak = isGrowing ? driftGrowthStreak + 1 : 0;
          prevDriftSec = driftSec;

          const sessionAgeMs = Date.now() - connectedAtMs;
          const sinceLastResyncMs = Date.now() - lastResyncAtRef.current;
          if (
            driftSec > DRIFT_RESYNC_THRESHOLD_SEC
            && driftGrowthStreak >= 2
            && sessionAgeMs >= DRIFT_MIN_SESSION_AGE_MS
            && sinceLastResyncMs >= DRIFT_MIN_RESYNC_INTERVAL_MS
          ) {
            void attemptReplacement(driftSec);
          }
        }

        setStatsText(
          `jitter ${jitterBufferMs != null ? `${jitterBufferMs.toFixed(0)}ms` : '—'}`
          + ` · loss ${lossPct != null ? `${lossPct.toFixed(1)}%` : '—'}`
          + ` · freezes ${sample.freezeCount} (${sample.totalFreezesDurationSec.toFixed(1)}s)`
          + ` · pauses ${sample.pauseCount} (${sample.totalPausesDurationSec.toFixed(1)}s)`
          + driftText,
        );
        onStats?.({ fps, lossPct, driftSec: driftSecForStats });
      } catch { /* ignore — try again next tick */ }
    };

    (async () => {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.ontrack = (ev) => {
        if (cancelled) return;
        const video = videoRef.current;
        if (video) video.srcObject = ev.streams[0];
      };

      pc.onconnectionstatechange = onConnectionStateChange;

      connectTimer = window.setTimeout(() => fail(new Error('webrtc connect timeout')), CONNECT_TIMEOUT_MS);

      const session = await negotiateWhepSession(pc, whepUrl, () => cancelled, true);
      if (!session) return; // cancelled before any attempt ever succeeded — nothing to clean up
      if (cancelled) {
        // Succeeded right as we were torn down (unmount/camera-switch race) — the
        // returned cleanup below already ran and had no sessionUrl to delete yet,
        // so this branch is the one responsible for tearing down this session.
        void deleteWhepSession(session.sessionUrl);
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
      if (sessionUrl) void deleteWhepSession(sessionUrl);
      pc?.close();
      activeReplacementCleanup?.();
    };
    // streamReady intentionally excluded - see comment above.
    // epoch is included on purpose: a failed/timed-out background replacement
    // bumps it to fall back to the old teardown/rebuild path for this effect.
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
