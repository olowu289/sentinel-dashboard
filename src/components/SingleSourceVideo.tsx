import { useEffect, useRef, useState } from 'react';
import { singleSourceUrl } from '../singleSource';

interface Props {
  camPath: string;
  /** True = show the annotated (/ai) stream; false = the raw (/raw) one. */
  ai: boolean;
  /** This feed's own video port, from the engine (see singleSource.ts). */
  port: number;
  onError?: (message: string | null) => void;
}

/**
 * Displays local_detect.py's MJPEG stream in a plain <img>. No player
 * library, no jitter buffer, no MSE - multipart/x-mixed-replace is decoded
 * natively and each JPEG is presented as it arrives, which is what keeps the
 * added display delay in the tens of ms rather than the hundreds an H.264
 * re-encode would cost.
 *
 * ONE <img>, and the connection budget is no longer shared.
 *
 * A browser allows six concurrent HTTP/1.1 connections per HOST:PORT, and an
 * MJPEG stream holds one open the whole time it is displayed. When every feed
 * was served from one port, four tiles competed for those six: mounting both
 * /raw and /ai per tile made it 8 and exactly three tiles rendered (6 / 2),
 * and even at one connection each, a DETECT toggle - which briefly holds the
 * old and new stream together - could still starve a neighbour to black.
 *
 * The engine now gives each feed its OWN port, so each has its own budget of
 * six and tiles cannot starve one another however the toggles are pressed.
 * The port is discovered from /healthz, never computed here.
 */
export default function SingleSourceVideo({ camPath, ai, port, onError }: Props) {
  const [nonce, setNonce] = useState(0);
  const failures = useRef(0);

  // An MJPEG <img> that errors has lost its connection (detector restarted,
  // cable pulled). Retry with a changing query so the browser cannot serve a
  // cached failure, backing off so a detector that is simply not running
  // doesn't spin.
  const handleError = () => {
    failures.current += 1;
    onError?.(
      `no stream from the local detector at ${singleSourceUrl(camPath, ai, port)} — ` +
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

  return (
    <img
      // Keyed on the endpoint as well as the nonce: React must replace the
      // element rather than mutate src on a live multipart connection, which
      // leaves the old stream attached in some browsers.
      key={`${ai ? 'ai' : 'raw'}-${nonce}`}
      src={`${singleSourceUrl(camPath, ai, port)}?n=${nonce}`}
      alt=""
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        background: '#000',
      }}
      onError={handleError}
      onLoad={handleLoad}
    />
  );
}
