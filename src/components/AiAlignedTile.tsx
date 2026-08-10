import { useRef, useState } from 'react';
import { aiWhepUrl } from '../aiConfig';
import EngineWhepVideo from './EngineWhepVideo';
import AiFrameSyncOverlay from './AiFrameSyncOverlay';

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
 * frame-correlated on top via AiFrameSyncOverlay — video and detections are
 * the exact same source AND properly time/frame-matched (not just "latest
 * on latest"), so this is the sync-CORRECT counterpart to cam1's Mode B tile
 * (cable video + AiOverlayCanvas's approximate overlay — see TowerFeed.tsx's
 * "MODE B" chip), useful for eyeballing drift against a moving drone.
 *
 * Off by default, toggled on deliberately: cam3 has no real hardware behind
 * it, and an always-on tile here would misleadingly look like a live camera
 * feed.
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
          {!engineError && <AiFrameSyncOverlay streamName={streamName} containerRef={tileRef} />}
          {engineError && <div className="cam-note">engine unreachable</div>}

          <span className="mode-chip mode-chip-a ai-aligned-mode-chip">MODE A · ENGINE + FRAME-SYNC</span>
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
