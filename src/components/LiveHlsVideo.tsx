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
}

export type LiveLatencySample = {
  t: number;
  hlsUrl: string;
  /** hls.js estimated latency behind live edge (seconds), if available */
  hlsLatencySec: number | null;
  /** liveSyncPosition - currentTime (seconds) */
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

/** Jump to live edge when this far behind sync (seconds). */
const LIVE_JUMP_SEC = 4;

/**
 * Buyer-tile live video via Platform API HLS (hub MediaMTX remux).
 * Tuned for steady mpegts + low lag (not LL-HLS). Exposes
 * window.__sentinelLiveMetrics for instrumentation.
 */
export default function LiveHlsVideo({ hlsUrl, apiKey, streamReady = true, ngrok = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState('connecting…');
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setNote(streamReady ? 'connecting…' : 'camera offline');
  }, [hlsUrl, streamReady]);

  useEffect(() => {
    if (!streamReady || !hlsUrl) {
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

    window.__sentinelLiveMetrics = {
      samples: [],
      last: null,
      stalls: 0,
    };

    const pushSample = (hls: Hls | undefined) => {
      let bufferedAhead: number | null = null;
      try {
        if (video.buffered.length > 0) {
          bufferedAhead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
        }
      } catch { /* ignore */ }

      const sync = hls?.liveSyncPosition;
      const lagBehindSync =
        sync != null && Number.isFinite(sync) ? sync - video.currentTime : null;

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
        bufferedAheadSec: bufferedAhead,
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

    const onPlaying = () => { setPlaying(true); setNote(''); };
    const onWaiting = () => {
      stallCount += 1;
      setNote('buffering…');
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    let hls: Hls | undefined;
    let reattach: number | undefined;
    let sampleTimer: number | undefined;

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
      // mpegts 2s segments on hub: aim ~1 segment behind live, catch up early.
      const hlsOpts = {
        lowLatencyMode: false,
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 2,
        maxLiveSyncPlaybackRate: 1.5,
        liveDurationInfinity: true,
        maxBufferLength: 4,
        maxMaxBufferLength: 6,
        backBufferLength: 4,
        highBufferWatchdogPeriod: 1,
        nudgeMaxRetry: 5,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 10000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 500,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 4,
        fragLoadingRetryDelay: 500,
        xhrSetup: (xhr: XMLHttpRequest) => attachHeaders(xhr),
      };
      hls = new Hls(hlsOpts);

      const jumpToLive = () => {
        try {
          const edge = hls?.liveSyncPosition;
          if (edge != null && Number.isFinite(edge) && Math.abs(video.currentTime - edge) > LIVE_JUMP_SEC) {
            video.currentTime = edge;
          }
        } catch { /* ignore */ }
      };

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        jumpToLive();
        video.play().catch(() => setNote('tap to play'));
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        jumpToLive();
        pushSample(hls);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setNote('stream reconnecting…');
          window.setTimeout(() => { try { hls?.startLoad(); } catch { /* gone */ } }, 1000);
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
              retry.on(Hls.Events.FRAG_LOADED, () => { jumpToLive(); pushSample(retry); });
              retry.loadSource(hlsUrl);
              retry.attachMedia(video);
            } catch { /* ignore */ }
          }, 2500);
        }
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      sampleTimer = window.setInterval(() => pushSample(hls), 2000);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      const sep = hlsUrl.includes('?') ? '&' : '?';
      video.src = `${hlsUrl}${sep}api_key=${encodeURIComponent(apiKey)}`;
      video.play().catch(() => setNote('tap to play'));
    } else {
      setNote('HLS not supported');
    }

    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      if (reattach) window.clearTimeout(reattach);
      if (sampleTimer) window.clearInterval(sampleTimer);
      if (hls) { try { hls.destroy(); } catch { /* gone */ } }
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
