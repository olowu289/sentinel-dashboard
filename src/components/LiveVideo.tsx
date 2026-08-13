import { useEffect, useRef, useState } from 'react';
import LiveWebrtcVideo from './LiveWebrtcVideo';
import type { TileStats } from '../liveStats';

interface Props {
  /** WHEP create-session URL on this tower's own MediaMTX. */
  whepUrl?: string;
  streamReady?: boolean;
  /** Kept for API compatibility with the tile; WebRTC has no seekable buffer
   * to snap, so nothing consumes it. */
  syncLiveTick?: number;
  /** Called on every stats sample from the playing transport. */
  onStats?: (s: TileStats) => void;
}

/** Transient failures happen (a camera restarting, MediaMTX reloading). Retry
 * a few times before telling the operator something is actually wrong. */
const MAX_WEBRTC_RETRIES = 3;
const WEBRTC_RETRY_BACKOFF_MS = 1500;

/**
 * WHEP, or an honest explanation. There is no second transport.
 *
 * The platform build fell back to HLS when WebRTC failed, and that was the
 * right trade when the alternative was no picture at all across someone
 * else's network. On a cable there is no hostile network to survive, and HLS
 * costs 5-12 seconds of buffering - the one thing this product cannot spend.
 * An operator slewing a camera against a ten-second-old picture is worse off
 * than one who has been told the link is down.
 *
 * So a failure here is reported, not papered over. It almost always means the
 * same thing: this machine is not on the camera segment.
 *
 * Everything that made the old fallback machinery necessary went with it -
 * the invisible background probe that tested WebRTC while HLS played, the
 * mode state, the swap-back logic. Retry is now just retry.
 */
export default function LiveVideo({ whepUrl, streamReady = true, onStats }: Props) {
  const [failed, setFailed] = useState(false);
  const [webrtcKey, setWebrtcKey] = useState(0);
  const attemptsRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  // A camera switch is a fresh start: clear the failure and the retry count
  // so the new tile is judged on its own connection, not the last one's.
  useEffect(() => {
    attemptsRef.current = 0;
    setFailed(false);
    setWebrtcKey((k) => k + 1);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [whepUrl]);

  const handleWebrtcFatal = () => {
    attemptsRef.current += 1;
    if (attemptsRef.current <= MAX_WEBRTC_RETRIES) {
      timerRef.current = window.setTimeout(
        () => setWebrtcKey((k) => k + 1),
        WEBRTC_RETRY_BACKOFF_MS,
      );
      return;
    }
    setFailed(true);
  };

  if (whepUrl && !failed) {
    return (
      <LiveWebrtcVideo
        key={webrtcKey}
        whepUrl={whepUrl}
        streamReady={streamReady}
        onFatalError={handleWebrtcFatal}
        onConnected={() => { attemptsRef.current = 0; }}
        onStats={onStats}
      />
    );
  }

  return (
    <div className="cam-video-wrap">
      <div className="cam-note">
        {whepUrl
          ? 'no video — check the cable and that this machine is on the camera segment'
          : 'no stream configured for this camera'}
      </div>
    </div>
  );
}
