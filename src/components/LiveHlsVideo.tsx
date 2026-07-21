import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

interface Props {
  /** Platform API HLS playlist URL (no api_key — headers preferred). */
  hlsUrl: string;
  apiKey: string;
  /** When false, tear down the player (camera offline / tower down). */
  streamReady?: boolean;
  /** True when control plane URL is ngrok (needs browser warning skip header). */
  ngrok?: boolean;
  /** Increment to snap playback to the live HLS edge (e.g. on PTZ). */
  syncLiveTick?: number;
}

export type LiveLatencySample = {
  t: number;
  hlsUrl: string;
  hlsLatencySec: number | null;
  lagBehindSyncSec: number | null;
  bufferedAheadSec: number | null;
  stallCount: number;
  lastFragLoadMs: number | null;
  lastProxyMs: number | null;
  lastHubUpstreamMs: number | null;
};

declare global {
  interface Window {
    __sentinelLiveMetrics?: {
      samples: LiveLatencySample[];
      last: LiveLatencySample | null;
      stalls: number;
    };
  }
}

/** Forward-only catch-up when lag exceeds this AND buffer has runway (seconds). */
const LIVE_CATCHUP_LAG_SEC = 45;

/** Safety margin before true playlist edge (seconds). */
const LIVE_EDGE_PAD_SEC = 0.35;

/** After PTZ, aim this close to the edge until NVR buffering resumes passively. */
const PTZ_TARGET_LATENCY_SEC = 2;

/**
 * Snap to the true live edge (not liveSyncPosition — that stays behind in buffered mode).
 * Forward-only; used on PTZ so the view matches the camera now.
 */
function snapToLiveEdge(hls: Hls, video: HTMLVideoElement) {
  const seekForward = () => {
    let target: number | null = null;

    const details = hls.latestLevelDetails;
    if (details?.live && Number.isFinite(details.edge)) {
      target = details.edge - LIVE_EDGE_PAD_SEC;
    }

    if (video.buffered.length > 0) {
      const bufEnd = video.buffered.end(video.buffered.length - 1) - LIVE_EDGE_PAD_SEC;
      if (target == null || bufEnd > target) target = bufEnd;
    }

    if (target == null) {
      const sync = hls.liveSyncPosition;
      if (sync != null && Number.isFinite(sync)) target = sync;
    }

    if (target != null && Number.isFinite(target) && target > video.currentTime + 0.1) {
      video.currentTime = target;
    }
    void video.play().catch(() => { /* autoplay policy */ });
  };

  try {
    // Briefly tighten latency target for the next load cycle, then NVR config takes over.
    hls.targetLatency = PTZ_TARGET_LATENCY_SEC;
    hls.startLoad(-1);
    seekForward();

    const onBuffered = () => {
      seekForward();
      hls.off(Hls.Events.FRAG_BUFFERED, onBuffered);
    };
    hls.on(Hls.Events.FRAG_BUFFERED, onBuffered);

    window.setTimeout(seekForward, 600);
    window.setTimeout(seekForward, 1800);
  } catch { /* ignore */ }
}

/**
 * NVR-style live HLS: deep buffer, play forward smoothly. PTZ triggers an explicit
 * jump to the true live edge so pan/zoom feedback is visible immediately.
 */
export default function LiveHlsVideo({ hlsUrl, apiKey, streamReady = true, ngrok = false, syncLiveTick = 0 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | undefined>(undefined);
  const snapLiveRef = useRef<(() => void) | null>(null);
  const [note, setNote] = useState('connecting…');
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!syncLiveTick || !streamReady) return;
    snapLiveRef.current?.();
  }, [syncLiveTick, streamReady]);

  useEffect(() => {
    setPlaying(false);
    setNote(streamReady ? 'connecting…' : 'camera offline');
  }, [hlsUrl, streamReady]);

  useEffect(() => {
    if (!streamReady || !hlsUrl) {
      snapLiveRef.current = null;
      const v = videoRef.current;
      if (v) {
        v.removeAttribute('src');
        v.load();
      }
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    let stallCount = 0;
    let lastFragLoadMs: number | null = null;
    let lastProxyMs: number | null = null;
    let lastHubUpstreamMs: number | null = null;
    let lowBufferTicks = 0;
    let lastPtzSnapMs = 0;

    window.__sentinelLiveMetrics = {
      samples: [],
      last: null,
      stalls: 0,
    };

    const bufferedAheadSec = (): number => {
      try {
        if (video.buffered.length === 0) return 0;
        return video.buffered.end(video.buffered.length - 1) - video.currentTime;
      } catch {
        return 0;
      }
    };

    const pushSample = (hls: Hls | undefined) => {
      const details = hls?.latestLevelDetails;
      const edge = details?.live && Number.isFinite(details.edge) ? details.edge : hls?.liveSyncPosition;
      const lagBehindSync =
        edge != null && Number.isFinite(edge) ? edge - video.currentTime : null;

      let hlsLatency: number | null = null;
      try {
        const lat = (hls as unknown as { latency?: number })?.latency;
        if (typeof lat === 'number' && Number.isFinite(lat)) hlsLatency = lat;
      } catch { /* ignore */ }

      const sample: LiveLatencySample = {
        t: Date.now(),
        hlsUrl,
        hlsLatencySec: hlsLatency,
        lagBehindSyncSec: lagBehindSync,
        bufferedAheadSec: bufferedAheadSec(),
        stallCount,
        lastFragLoadMs,
        lastProxyMs,
        lastHubUpstreamMs,
      };
      const bucket = window.__sentinelLiveMetrics!;
      bucket.samples.push(sample);
      if (bucket.samples.length > 120) bucket.samples.shift();
      bucket.last = sample;
      bucket.stalls = stallCount;
    };

    let hls: Hls | undefined;
    let reattach: number | undefined;
    let healthTimer: number | undefined;
    let sampleTimer: number | undefined;

    const nudgeLoader = () => {
      try { hls?.startLoad(-1); } catch { /* ignore */ }
    };

    /** Passive NVR catch-up — only when extremely far behind. */
    const catchUpIfNeeded = () => {
      if (!hls) return;
      try {
        const details = hls.latestLevelDetails;
        const edge = details?.live && Number.isFinite(details.edge)
          ? details.edge
          : hls.liveSyncPosition;
        if (edge == null || !Number.isFinite(edge)) return;
        const lag = edge - video.currentTime;
        if (lag < LIVE_CATCHUP_LAG_SEC) return;
        const ahead = bufferedAheadSec();
        if (ahead < 3) return;
        const target = Math.min(edge - LIVE_EDGE_PAD_SEC, video.currentTime + ahead - 1.5);
        if (target > video.currentTime + 5) {
          video.currentTime = target;
        }
      } catch { /* ignore */ }
    };

    const onPlaying = () => { setPlaying(true); setNote(''); };
    const onWaiting = () => {
      stallCount += 1;
      setNote('buffering…');
      nudgeLoader();
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    const attachHeaders = (xhr: XMLHttpRequest) => {
      xhr.setRequestHeader('X-Kallon-Api-Key', apiKey);
      if (ngrok) xhr.setRequestHeader('ngrok-skip-browser-warning', '1');
      const t0 = performance.now();
      xhr.addEventListener('loadend', () => {
        lastFragLoadMs = performance.now() - t0;
        try {
          const proxy = xhr.getResponseHeader('X-Kallon-Proxy-Ms');
          const upstream = xhr.getResponseHeader('X-Kallon-Hub-Upstream-Ms')
            || xhr.getResponseHeader('X-Kallon-Upstream-Ms');
          if (proxy) lastProxyMs = parseFloat(proxy);
          if (upstream) lastHubUpstreamMs = parseFloat(upstream);
        } catch { /* ignore */ }
      });
    };

    if (Hls.isSupported()) {
      const hlsOpts = {
        lowLatencyMode: false,
        liveSyncMode: 'buffered' as const,
        liveSyncDurationCount: 4,
        liveMaxLatencyDurationCount: 30,
        maxLiveSyncPlaybackRate: 1,
        liveSyncOnStallIncrease: 1,
        liveDurationInfinity: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 80 * 1000 * 1000,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 3,
        nudgeMaxRetry: 12,
        startFragPrefetch: true,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 8,
        manifestLoadingRetryDelay: 1000,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 8,
        levelLoadingRetryDelay: 1000,
        fragLoadingTimeOut: 45000,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 1000,
        xhrSetup: (xhr: XMLHttpRequest) => attachHeaders(xhr),
      };
      hls = new Hls(hlsOpts);
      hlsRef.current = hls;

      snapLiveRef.current = () => {
        if (!hls) return;
        const now = Date.now();
        if (now - lastPtzSnapMs < 350) return;
        lastPtzSnapMs = now;
        snapToLiveEdge(hls, video);
      };

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => setNote('tap to play'));
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        pushSample(hls);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data) return;
        if (!data.fatal) {
          if (
            data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR
            || data.details === Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE
          ) {
            nudgeLoader();
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setNote('stream reconnecting…');
          window.setTimeout(nudgeLoader, 1500);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls?.recoverMediaError(); } catch { setNote('set substream to H.264'); }
        } else {
          setNote('stream unavailable');
          try { hls?.destroy(); } catch { /* gone */ }
          reattach = window.setTimeout(() => {
            setNote('retrying…');
            try {
              const retry = new Hls(hlsOpts);
              hls = retry;
              hlsRef.current = retry;
              snapLiveRef.current = () => {
                if (!hls) return;
                const now = Date.now();
                if (now - lastPtzSnapMs < 350) return;
                lastPtzSnapMs = now;
                snapToLiveEdge(hls, video);
              };
              retry.on(Hls.Events.FRAG_LOADED, () => { pushSample(retry); });
              retry.loadSource(hlsUrl);
              retry.attachMedia(video);
            } catch { /* ignore */ }
          }, 3000);
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      healthTimer = window.setInterval(() => {
        const ahead = bufferedAheadSec();
        if (ahead < 2) {
          lowBufferTicks += 1;
          if (lowBufferTicks >= 2) nudgeLoader();
        } else {
          lowBufferTicks = 0;
        }
        catchUpIfNeeded();
      }, 5000);

      sampleTimer = window.setInterval(() => pushSample(hls), 5000);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      snapLiveRef.current = null;
      const sep = hlsUrl.includes('?') ? '&' : '?';
      video.src = `${hlsUrl}${sep}api_key=${encodeURIComponent(apiKey)}`;
      video.play().catch(() => setNote('tap to play'));
    } else {
      setNote('HLS not supported');
    }

    return () => {
      snapLiveRef.current = null;
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      if (reattach) window.clearTimeout(reattach);
      for (const id of snapTimers) window.clearTimeout(id);
      if (healthTimer) window.clearInterval(healthTimer);
      if (sampleTimer) window.clearInterval(sampleTimer);
      if (hls) { try { hls.destroy(); } catch { /* gone */ } }
      hlsRef.current = undefined;
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
    };
  }, [hlsUrl, apiKey, streamReady, ngrok]);

  return (
    <div className="cam-video-wrap">
      <video ref={videoRef} className="cam-video" muted playsInline autoPlay />
      {!playing && <div className="cam-note">{note}</div>}
    </div>
  );
}
