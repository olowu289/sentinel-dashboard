import { useRef, useState } from 'react';
import { aiWhepUrl } from '../aiConfig';
import EngineWhepVideo from './EngineWhepVideo';
import AiOverlayCanvas from './AiOverlayCanvas';

interface Props {
  /** Engine stream name (as registered via POST /v1/streams), e.g. "kallon_cam1_main". */
  streamName: string;
  /** Human label for the source camera this is an engine's-eye view OF — shown in the off-state copy so it's never mistaken for real cam3 hardware. */
  cameraLabel: string;
  /** True when the dashboard is in spotlight mode — this tile is never the
   * spotlighted one (it has no PTZ/selection), so it always renders as a
   * filmstrip thumb alongside whichever real camera IS spotlighted. */
  spotlightThumb?: boolean;
}

/**
 * Mode A "AI Aligned View": the Perception Engine's OWN video (WHEP,
 * straight from its co-located MediaMTX) with the engine's OWN detections
 * drawn on top — video and boxes are the exact same source, so alignment is
 * pixel-correct by construction. Occupies the empty cam3 tile slot as a
 * side-by-side comparison against cam1's normal tile (Mode B: cable video +
 * overlay — see TowerFeed.tsx's "MODE B" chip — which pulls a different,
 * lower-res substream and can disagree slightly on framing/latency).
 *
 * Off by default, toggled on deliberately: cam3 has no real hardware behind
 * it, and an always-on tile here would misleadingly look like a live camera
 * feed. AiOverlayCanvas is reused completely unmodified — it locates ANY
 * <video class="cam-video"> inside its containerRef and already applies the
 * same AI_VIEW_MIN_CONF display filter cam1's own overlay uses, so this
 * comparison is like-for-like for free.
 */
export default function AiAlignedTile({ streamName, cameraLabel, spotlightThumb = false }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [engineError, setEngineError] = useState(false);
  const tileRef = useRef<HTMLDivElement>(null);
  const whepUrl = aiWhepUrl(streamName);

  const tileClass = `ai-aligned-tile${spotlightThumb ? ' is-thumb' : ''}`;

  return (
    <div ref={tileRef} className={tileClass}>
      {!enabled && (
        <div className="ai-aligned-off">
          <div className="ai-aligned-off-label">AI ALIGNED VIEW</div>
          <div className="ai-aligned-off-sub">
            Engine video + engine detections for {cameraLabel} — not a real camera. Toggle on to compare against {cameraLabel}&apos;s own tile.
          </div>
          <button className="ai-aligned-toggle-btn" onClick={() => { setEngineError(false); setEnabled(true); }}>
            ENABLE
          </button>
        </div>
      )}

      {enabled && (
        <>
          {!engineError && (
            <EngineWhepVideo
              whepUrl={whepUrl}
              onFatalError={() => setEngineError(true)}
              onConnected={() => setEngineError(false)}
            />
          )}
          {!engineError && <AiOverlayCanvas streamName={streamName} containerRef={tileRef} />}
          {engineError && <div className="cam-note">engine unreachable</div>}

          <span className="mode-chip mode-chip-a ai-aligned-mode-chip">MODE A · ENGINE</span>
          <button
            className="ai-aligned-disable-btn"
            onClick={() => setEnabled(false)}
            aria-label="Disable AI Aligned View"
            title="Disable AI Aligned View"
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
