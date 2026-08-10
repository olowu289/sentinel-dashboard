import { useEffect, useRef, useState, type RefObject } from 'react';
import { colors, font } from '../tokens';
import { connectFrameSync, type FrameSyncHandle } from '../aiFrameSync';
import { drawAiOverlay, type LinkState } from '../aiOverlay';

interface Props {
  streamName: string;
  /** Same "find the video by class, don't assume which player" pattern as
   * AiOverlayCanvas — see its doc for why. Here it also gives us the exact
   * <video> node needed for requestVideoFrameCallback. */
  containerRef: RefObject<HTMLDivElement | null>;
}

/** Not in every TS lib.dom yet — declared locally rather than widening the
 * project's tsconfig lib target for one experimental (but well-supported,
 * Chromium/Safari) API. Feature-detected at runtime either way. */
interface VideoFrameCallbackMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
}
type VideoFrameRequestCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void;
interface VideoElementWithRvfc extends HTMLVideoElement {
  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback(handle: number): void;
}

function hasRvfc(video: HTMLVideoElement): video is VideoElementWithRvfc {
  return typeof (video as Partial<VideoElementWithRvfc>).requestVideoFrameCallback === 'function';
}

/**
 * Mode A's sync-correct overlay: drives its draw loop from
 * video.requestVideoFrameCallback (one callback per actually-PAINTED frame,
 * carrying a presentedFrames counter) rather than requestAnimationFrame, and
 * asks aiFrameSync's calibrated matcher which detection corresponds to THAT
 * frame — never just "whatever's newest" (see AiOverlayCanvas/aiOverlay.ts,
 * which cam1's Mode B tile still uses, for the drift that produces on a
 * moving target). Falls back to a fixed-delay wall-clock match if rVFC isn't
 * available in this browser, per the reference doc's degradation note.
 *
 * drawAiOverlay itself is reused unmodified from aiOverlay.ts — same
 * AI_VIEW_MIN_CONF filter, same scaling math — only WHICH detection body
 * gets passed to it differs from AiOverlayCanvas.
 */
export default function AiFrameSyncOverlay({ streamName, containerRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<FrameSyncHandle | null>(null);
  const [wsState, setWsState] = useState<LinkState>('connecting');
  const [streamEngineState, setStreamEngineState] = useState<string | null>(null);
  const [detPerSec, setDetPerSec] = useState(0);
  const [shownPerSec, setShownPerSec] = useState(0);
  const [calibrationOffset, setCalibrationOffset] = useState<number | null>(null);
  const [matchHitRate, setMatchHitRate] = useState<number | null>(null);
  /** null = not yet determined (video not found), true = true frame-sync, false = fallback. */
  const [usingRvfc, setUsingRvfc] = useState<boolean | null>(null);

  useEffect(() => {
    setWsState('connecting');
    setStreamEngineState(null);
    setCalibrationOffset(null);
    setMatchHitRate(null);
    const handle = connectFrameSync(streamName, {
      onWsState: setWsState,
      onStreamEngineState: setStreamEngineState,
      onCounts: (det, shown) => { setDetPerSec(det); setShownPerSec(shown); },
      onCalibration: setCalibrationOffset,
      onMatchStats: setMatchHitRate,
    });
    handleRef.current = handle;
    return () => {
      handle.close();
      handleRef.current = null;
    };
  }, [streamName]);

  useEffect(() => {
    let cancelled = false;
    let video: HTMLVideoElement | null = null;
    let rvfcHandle: number | undefined;
    let rafHandle: number | undefined;
    let findRaf: number | undefined;

    const drawWith = (latest: ReturnType<FrameSyncHandle['matchByDelay']>) => {
      const canvas = canvasRef.current;
      if (!canvas || !video) return;
      const boxW = video.clientWidth;
      const boxH = video.clientHeight;
      if (!boxW || !boxH) return;
      if (canvas.width !== boxW) canvas.width = boxW;
      if (canvas.height !== boxH) canvas.height = boxH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // .cam-video is object-fit: cover (see styles.css) — same as AiOverlayCanvas.
      drawAiOverlay(ctx, boxW, boxH, video, latest, 'cover', {
        stroke: colors.accentText,
        font: `600 11px ${font.mono}`,
      });
    };

    const startLoop = () => {
      if (!video) return;
      if (hasRvfc(video)) {
        setUsingRvfc(true);
        const v = video;
        const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
          if (cancelled) return;
          drawWith(handleRef.current?.matchPresentedFrame(metadata.presentedFrames));
          rvfcHandle = v.requestVideoFrameCallback(onFrame);
        };
        rvfcHandle = v.requestVideoFrameCallback(onFrame);
      } else {
        setUsingRvfc(false);
        const onRaf = () => {
          if (cancelled) return;
          drawWith(handleRef.current?.matchByDelay());
          rafHandle = window.requestAnimationFrame(onRaf);
        };
        rafHandle = window.requestAnimationFrame(onRaf);
      }
    };

    const findVideo = () => {
      if (cancelled) return;
      const v = containerRef.current?.querySelector<HTMLVideoElement>('video.cam-video');
      if (v) {
        video = v;
        startLoop();
      } else {
        findRaf = window.requestAnimationFrame(findVideo);
      }
    };
    findVideo();

    return () => {
      cancelled = true;
      if (findRaf) window.cancelAnimationFrame(findRaf);
      if (rafHandle) window.cancelAnimationFrame(rafHandle);
      if (video && rvfcHandle !== undefined && hasRvfc(video)) {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
    };
  }, [containerRef]);

  const wsLabel = wsState === 'open' ? 'WS OK' : wsState === 'error' ? 'WS ERR' : 'WS…';
  const syncLabel = usingRvfc === null ? null : usingRvfc ? 'rVFC-sync' : 'fallback';

  return (
    <>
      <canvas ref={canvasRef} className="ai-overlay-canvas" />
      <div className="ai-overlay-chip">
        <span>{wsLabel}</span>
        <span>{detPerSec.toFixed(0)} det/s</span>
        <span>{shownPerSec.toFixed(0)} shown/s</span>
        {syncLabel && <span>{syncLabel}</span>}
        {calibrationOffset !== null && <span>off={calibrationOffset}</span>}
        {matchHitRate !== null && <span>{matchHitRate.toFixed(0)}% hit</span>}
        {streamEngineState && <span>{streamEngineState.toUpperCase()}</span>}
      </div>
    </>
  );
}
