import { useEffect, useRef, useState, type RefObject } from 'react';
import { colors, font } from '../tokens';
import { connectAiOverlay, drawAiOverlay, type AiOverlayHandle, type LinkState } from '../aiOverlay';
import { reportDetections } from '../aiDetectionAlert';

interface Props {
  streamName: string;
  /**
   * The tile's outer container, used to find the currently-mounted
   * video.cam-video each animation frame. Deliberately not a direct video
   * ref: LiveVideo swaps between LiveHlsVideo's and LiveWebrtcVideo's own
   * independent <video> elements as it retries/falls back, and this overlay
   * has no business knowing which one is live at any given moment — it just
   * rides whatever is currently rendered under this container (see
   * aiOverlay.ts's module doc: video and detections are intentionally
   * separate paths).
   */
  containerRef: RefObject<HTMLDivElement | null>;
}

/** Per-tile status chip: WS link state + det/s vs shown/s — subtle, corner-of-tile. */
export default function AiOverlayCanvas({ streamName, containerRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<AiOverlayHandle | null>(null);
  const [wsState, setWsState] = useState<LinkState>('connecting');
  const [streamEngineState, setStreamEngineState] = useState<string | null>(null);
  const [detPerSec, setDetPerSec] = useState(0);
  const [shownPerSec, setShownPerSec] = useState(0);

  useEffect(() => {
    setWsState('connecting');
    setStreamEngineState(null);
    const handle = connectAiOverlay(streamName, {
      onWsState: setWsState,
      onStreamEngineState: setStreamEngineState,
      onCounts: (det, shown) => { setDetPerSec(det); setShownPerSec(shown); },
      onDetections: (detections) => reportDetections(detections, Date.now()),
    });
    handleRef.current = handle;
    return () => {
      handle.close();
      handleRef.current = null;
    };
  }, [streamName]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const video = containerRef.current?.querySelector<HTMLVideoElement>('video.cam-video');
      if (canvas && video) {
        const boxW = video.clientWidth;
        const boxH = video.clientHeight;
        if (boxW && boxH) {
          if (canvas.width !== boxW) canvas.width = boxW;
          if (canvas.height !== boxH) canvas.height = boxH;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            // .cam-video is styled object-fit: cover (see styles.css) — must
            // match here or boxes drift off the visible, cropped video.
            drawAiOverlay(ctx, boxW, boxH, video, handleRef.current?.getLatest(), 'cover', {
              stroke: colors.accentText,
              font: `600 11px ${font.mono}`,
            });
          }
        }
      }
      raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [containerRef]);

  const wsLabel = wsState === 'open' ? 'WS OK' : wsState === 'error' ? 'WS ERR' : 'WS…';

  return (
    <>
      <canvas ref={canvasRef} className="ai-overlay-canvas" />
      <div className="ai-overlay-chip">
        <span>{wsLabel}</span>
        <span>{detPerSec.toFixed(0)} det/s</span>
        <span>{shownPerSec.toFixed(0)} shown/s</span>
        {streamEngineState && <span>{streamEngineState.toUpperCase()}</span>}
      </div>
    </>
  );
}
