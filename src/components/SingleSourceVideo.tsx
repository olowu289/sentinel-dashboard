import { useEffect, useRef, useState } from 'react';
import { singleSourceUrl } from '../singleSource';

interface Props {
  camPath: string;
  /** True = show the annotated (/ai) stream; false = the raw (/raw) one. */
  ai: boolean;
  onError?: (message: string | null) => void;
}

/**
 * Displays local_detect.py's MJPEG stream in a plain <img>. No player
 * library, no jitter buffer, no MSE - multipart/x-mixed-replace is decoded
 * natively and each JPEG is presented as it arrives, which is what keeps the
 * added display delay in the tens of ms rather than the hundreds an H.264
 * re-encode would cost.
 *
 * BOTH streams stay mounted and connected at all times, and the AI toggle
 * only changes which one is on top. Switching an <img src> would tear down
 * the HTTP connection and reconnect, giving a visible black flash on every
 * toggle; keeping both warm avoids that entirely and is genuinely cheap here
 * - measured ~9KB/frame, so the idle stream costs about 1-2 Mbit/s on a
 * cable and ~0.5ms of JPEG encode per frame on the PC. (The /raw encode only
 * happens while a client is actually connected, so nothing is spent when
 * this component is not mounted.)
 *
 * Stacking rather than unmounting also means the hidden stream is already at
 * the live edge when you switch to it - no reconnect, no first-frame wait.
 */
export default function SingleSourceVideo({ camPath, ai, onError }: Props) {
  const [nonce, setNonce] = useState(0);
  const failures = useRef(0);

  // An MJPEG <img> that errors has lost its connection (detector restarted,
  // cable pulled). Retry with a changing query so the browser cannot serve a
  // cached failure, backing off so a detector that is simply not running
  // doesn't spin.
  const handleError = () => {
    failures.current += 1;
    onError?.(
      `no stream from the local detector at ${singleSourceUrl(camPath, ai)} — ` +
      `is local_detect.py running with serve_mjpeg on?`,
    );
    const delay = Math.min(10_000, 1000 * failures.current);
    window.setTimeout(() => setNonce((n) => n + 1), delay);
  };

  const handleLoad = () => {
    failures.current = 0;
    onError?.(null);
  };

  useEffect(() => () => onError?.(null), [onError]);

  const common: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    background: '#000',
  };

  return (
    <>
      {/* Both mounted so both connections stay live; only z-index/opacity
          changes on toggle. Do NOT swap to conditional rendering here - that
          reintroduces the reconnect flash this is built to avoid. */}
      <img
        key={`raw-${nonce}`}
        src={`${singleSourceUrl(camPath, false)}?n=${nonce}`}
        alt=""
        style={{ ...common, opacity: ai ? 0 : 1, zIndex: ai ? 0 : 1 }}
        onError={handleError}
        onLoad={handleLoad}
      />
      <img
        key={`ai-${nonce}`}
        src={`${singleSourceUrl(camPath, true)}?n=${nonce}`}
        alt=""
        style={{ ...common, opacity: ai ? 1 : 0, zIndex: ai ? 1 : 0 }}
        onError={handleError}
        onLoad={handleLoad}
      />
    </>
  );
}
