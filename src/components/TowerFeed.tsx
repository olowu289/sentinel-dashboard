import { useRef, useState } from 'react';
import type { Camera } from '../types';
import { colors, font } from '../tokens';
import type { TileStats } from '../liveStats';
import LiveVideo from './LiveVideo';
import AiOverlayCanvas from './AiOverlayCanvas';
import SingleSourceVideo from './SingleSourceVideo';
import { aiStreamNameFor } from '../aiConfig';
import { singleSourceAvailable } from '../singleSource';

interface Props {
  camera: Camera;
  selected: boolean;
  accent: string;
  spotlighted: boolean;
  thumb: boolean;
  onSelect: () => void;
  onToggleSpotlight: () => void;
  onSnapshot: () => Promise<string | null>;
  /** WHEP create-session URL on this tower's own MediaMTX. */
  whepUrl?: string;
  /** When set, snap this tile to the live HLS edge (PTZ on selected camera). */
  syncLiveTick?: number;
}

/** Empty while connecting — the centered "connecting…" overlay already
 * covers that state, so the footer stays quiet instead of repeating it. */
function telemetryText(hasSource: boolean, stats: TileStats | null): string {
  if (!hasSource) return 'no stream';
  if (!stats) return '';
  const fps = stats.fps != null ? `${stats.fps.toFixed(1)} fps` : '— fps';
  const loss = stats.lossPct != null ? `loss ${stats.lossPct.toFixed(1)}%` : 'loss —';
  const drift = stats.driftSec != null ? `drift ~${Math.abs(stats.driftSec).toFixed(1)}s` : 'drift —';
  return `${fps} · ${loss} · ${drift}`;
}

/**
 * One camera tile: live video under a gradient scrim, with a header (name +
 * status) and footer (stream telemetry + quick actions). Snapshot toolbar
 * still downloads a one-shot JPEG from the tower (not a continuous
 * poll). Recording is toggled from the control panel; tiles only reflect
 * the global recording flag.
 */
export default function TowerFeed({
  camera, selected, accent, spotlighted, thumb, onSelect, onToggleSpotlight, onSnapshot,
  whepUrl, syncLiveTick,
}: Props) {
  const [flash, setFlash] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [stats, setStats] = useState<TileStats | null>(null);
  const [aiOverlayOn, setAiOverlayOn] = useState(false);
  const [singleSourceError, setSingleSourceError] = useState<string | null>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  // SINGLE-SOURCE MODE: video comes from the local detector's annotated MJPEG
  // instead of WHEP/HLS, and the AI button switches which of its two
  // endpoints is shown rather than toggling a client-side canvas. The boxes
  // are burned into the frame they were detected from, and the same detection
  // record drives the tracker - see singleSource.ts. Off by default; the
  // WHEP/HLS + AiOverlayCanvas path below is untouched and is the revert.
  const singleSource = singleSourceAvailable(camera.path);
  // Always attempt the connection. The stream-readiness flag came from the
  // hub's view of the tower, which could be stale or simply wrong while the
  // cable in front of you is fine - so the transport reports its own success
  // or failure rather than being pre-judged.
  const streamReady = true;
  const hasSource = singleSource || !!whepUrl;
  const aiStreamName = aiStreamNameFor(camera.path);

  const statusColor =
    camera.status === 'ONLINE' ? colors.online : camera.status === 'STANDBY' ? colors.standby : colors.offlineLabel;

  const snapshot = () => {
    setFlash(true);
    window.setTimeout(() => setFlash(false), 380);
    onSnapshot().then((path) => {
      if (path) {
        setSaveNote(path === 'downloaded' ? 'Snapshot downloaded' : `Saved to ${path}`);
        window.setTimeout(() => setSaveNote(null), 4500);
      }
    });
  };

  const feedClass = `feed${selected ? ' selected' : ''}${spotlighted ? ' is-spotlight' : ''}${thumb ? ' is-thumb' : ''}`;

  return (
    <div
      ref={tileRef}
      className={feedClass}
      onClick={onSelect}
      style={{
        position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden',
        cursor: 'pointer', userSelect: 'none',
        background: `linear-gradient(180deg, ${colors.feedTop} 0%, ${colors.feedMid} 46%, ${colors.feedBot} 100%)`,
        borderColor: selected ? accent : colors.line2,
        boxShadow: selected
          ? `0 0 0 1px ${colors.accentBorder}, 0 10px 40px rgba(90,100,255,.12)`
          : '0 8px 26px rgba(0,0,0,.35)',
      }}
    >
      {!hasSource && (
        <div className="feed-nosignal">
          <div className="feed-nosignal-ring"><span /></div>
          <div className="feed-nosignal-label">NO SIGNAL</div>
        </div>
      )}

      {singleSource ? (
        <SingleSourceVideo camPath={camera.path} ai={aiOverlayOn} onError={setSingleSourceError} />
      ) : (
        whepUrl && (
          <LiveVideo
            whepUrl={whepUrl}
            streamReady={streamReady}
            syncLiveTick={syncLiveTick}
            onStats={setStats}
          />
        )
      )}

      {/* Client-side overlay ONLY on the legacy path - in single-source mode
          the boxes are already burned into the frame by the detector, and
          drawing them again here would double them (and reintroduce exactly
          the drift this replaces). */}
      {!singleSource && aiOverlayOn && aiStreamName && (
        <AiOverlayCanvas streamName={aiStreamName} containerRef={tileRef} />
      )}

      {singleSource && singleSourceError && (
        <div className="cam-note" style={{ position: 'absolute', inset: 'auto 8px 8px 8px', zIndex: 3 }}>
          {singleSourceError}
        </div>
      )}

      <div className="feed-scrim" />

      <div className="feed-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span className="feed-name">{camera.label}</span>
          {selected && <span className="feed-controlling">CONTROLLING</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
          {singleSource ? (
            <span className="mode-chip mode-chip-b">SINGLE SOURCE · CABLE + FRAME-LOCKED</span>
          ) : (
            aiStreamName && <span className="mode-chip mode-chip-b">MODE B · CABLE + APPROX-SYNC</span>
          )}
          <div className="feed-status-chip" style={{ color: statusColor }}>
            <span style={{ background: statusColor }} />
            {camera.status}
          </div>
        </div>
      </div>

      {camera.recording && (
        <div className="feed-rec-badge">
          <span className="rec-dot" />
          REC
        </div>
      )}

      <div className="feed-foot">
        <span className="feed-telemetry" style={{ fontFamily: font.mono }}>{telemetryText(hasSource, stats)}</span>
        <div className="feed-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="feed-action-btn"
            onClick={onToggleSpotlight}
            aria-pressed={spotlighted}
            aria-label={spotlighted ? 'Exit fullscreen' : 'Fullscreen this feed'}
            title={spotlighted ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {spotlighted ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            )}
          </button>

          <button className="feed-action-btn" onClick={snapshot} aria-label="Capture snapshot" title="Snapshot">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>

          {aiStreamName && (
            <button
              className="feed-action-btn feed-ai-btn"
              onClick={() => setAiOverlayOn((v) => !v)}
              aria-pressed={aiOverlayOn}
              aria-label={aiOverlayOn ? 'Hide AI detection overlay' : 'Show AI detection overlay'}
              title="AI detection overlay"
            >
              AI
            </button>
          )}
        </div>
      </div>

      {flash && <div className="snap-flash" style={{ position: 'absolute', inset: 0, background: '#eef3f7', pointerEvents: 'none', zIndex: 3 }} />}
      {saveNote && <div className="snap-toast">{saveNote}</div>}
    </div>
  );
}
