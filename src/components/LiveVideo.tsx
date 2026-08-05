import { useEffect, useRef, useState } from 'react';
import LiveHlsVideo from './LiveHlsVideo';
import LiveWebrtcVideo from './LiveWebrtcVideo';

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
 */
const MAX_WEBRTC_RETRIES = 3;
const WEBRTC_RETRY_BACKOFF_MS = 2000;
/** After falling back to HLS, periodically try WebRTC again in case the link recovered. */
const HLS_COOLDOWN_MS = 45000;

/**
 * Picks the best available live-video transport for one camera tile: tries WebRTC
 * (sub-second latency) first when a whepUrl is available. A WebRTC failure retries
 * WebRTC itself first (see constants above) since the usual cause is a transient
 * upstream blip, not a lasting incompatibility; only after repeated failures does
 * it fall back to HLS (buffered, ~5-12s, but works everywhere) — and even then it
 * periodically retries WebRTC rather than staying on HLS for the rest of the mount.
 * A fresh mount (camera switch) always retries WebRTC first.
 */
export default function LiveVideo({ hlsUrl, whepUrl, apiKey, streamReady = true, ngrok = false, syncLiveTick }: Props) {
  const [mode, setMode] = useState<Mode>(() => initialMode(whepUrl, hlsUrl));
  const [webrtcKey, setWebrtcKey] = useState(0);
  const attemptsRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

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
    if (attemptsRef.current <= MAX_WEBRTC_RETRIES) {
      timerRef.current = window.setTimeout(() => {
        setWebrtcKey((k) => k + 1);
      }, WEBRTC_RETRY_BACKOFF_MS);
      return;
    }
    setMode(hlsUrl ? 'hls' : 'none');
    if (hlsUrl && whepUrl) {
      timerRef.current = window.setTimeout(() => {
        attemptsRef.current = 0;
        setWebrtcKey((k) => k + 1);
        setMode('webrtc');
      }, HLS_COOLDOWN_MS);
    }
  };

  if (mode === 'webrtc' && whepUrl) {
    return (
      <LiveWebrtcVideo
        key={webrtcKey}
        whepUrl={whepUrl}
        apiKey={apiKey}
        ngrok={ngrok}
        streamReady={streamReady}
        onFatalError={handleWebrtcFatal}
        onConnected={() => { attemptsRef.current = 0; }}
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
      />
    );
  }

  return (
    <div className="cam-video-wrap">
      <div className="cam-note">no stream configured</div>
    </div>
  );
}
