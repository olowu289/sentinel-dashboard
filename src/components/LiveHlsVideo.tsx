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

/**
 * Buyer-tile live video via Platform API HLS (hub MediaMTX remux).
 * hls.js: X-Kallon-Api-Key on every playlist/segment request.
 * Safari native: falls back to ?api_key= on the playlist URL.
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

    const onPlaying = () => { setPlaying(true); setNote(''); };
    const onWaiting = () => setNote('buffering…');
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    let hls: Hls | undefined;
    let reattach: number | undefined;

    const attachHeaders = (xhr: XMLHttpRequest) => {
      xhr.setRequestHeader('X-Kallon-Api-Key', apiKey);
      if (ngrok) xhr.setRequestHeader('ngrok-skip-browser-warning', '1');
    };

    if (Hls.isSupported()) {
      const hlsOpts = {
        // Keep mpegts (not LL-HLS); aim ~4–6s behind live instead of ~20s.
        lowLatencyMode: false,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 12,
        maxMaxBufferLength: 24,
        backBufferLength: 12,
        manifestLoadingRetryDelay: 2000,
        levelLoadingRetryDelay: 2000,
        xhrSetup: (xhr: XMLHttpRequest) => attachHeaders(xhr),
      };
      hls = new Hls(hlsOpts);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => setNote('tap to play'));
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setNote('stream reconnecting…');
          window.setTimeout(() => { try { hls?.startLoad(); } catch { /* gone */ } }, 1500);
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
              retry.loadSource(hlsUrl);
              retry.attachMedia(video);
            } catch { /* ignore */ }
          }, 3000);
        }
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
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
