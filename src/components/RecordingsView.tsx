import { useMemo, useState } from 'react';
import { colors, font } from '../tokens';
import { formatClockUTC1, formatDateTimeUTC1, formatBytes } from '../clock';
import { usePlatform } from '../platformContext';
import { useRecordings } from '../useRecordings';
import type { Tower } from '../types';

interface Props {
  towers: Tower[];
  selectedTowerId: string;
  onSelectTower: (id: string) => void;
}

export default function RecordingsView({ towers, selectedTowerId, onSelectTower }: Props) {
  const { session } = usePlatform();
  const [camera, setCamera] = useState<number | undefined>(undefined);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [playingLabel, setPlayingLabel] = useState('');
  const [busyId, setBusyId] = useState('');
  const [now] = useState(() => Date.now());

  const deviceId = selectedTowerId || undefined;
  const { segments, retentionDays, loading, error, refresh, play, download, remove } = useRecordings(
    deviceId,
    { camera, enabled: !!deviceId },
  );

  const towerLabel = useMemo(
    () => towers.find((t) => t.id === selectedTowerId)?.name ?? selectedTowerId,
    [towers, selectedTowerId],
  );

  const clock = formatClockUTC1(now);

  return (
    <div className="app recordings-view">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: font.display, fontWeight: 700, fontSize: 24, letterSpacing: '.24em', color: colors.textBright }}>SENTINEL</span>
          <span style={{ fontFamily: font.display, fontWeight: 500, fontSize: 14, letterSpacing: '.32em', color: colors.textFaint }}>RECORDINGS</span>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontFamily: font.mono, fontSize: 19, color: colors.textBright, letterSpacing: '.06em' }}>{clock}</div>
          <div style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: '.16em', color: colors.textFaint }}>UTC+1 · CLOUD RETENTION {retentionDays}D</div>
        </div>
      </header>

      <div className="rec-toolbar">
        <label className="rec-filter">
          <span>TOWER</span>
          <select value={selectedTowerId} onChange={(e) => onSelectTower(e.target.value)}>
            {towers.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="rec-filter">
          <span>CAMERA</span>
          <select
            value={camera ?? ''}
            onChange={(e) => setCamera(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">All</option>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>CAM {String(n).padStart(2, '0')}</option>
            ))}
          </select>
        </label>
        <button type="button" className="ctl-btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'LOADING…' : 'REFRESH'}
        </button>
      </div>

      {error && <div className="login-error rec-error">{error}</div>}

      <div className="rec-layout">
        <div className="rec-list">
          <div className="rec-list-head">
            <span>{towerLabel}</span>
            <span>{segments.length} segment{segments.length === 1 ? '' : 's'}</span>
          </div>
          {segments.length === 0 && !loading && (
            <div className="rec-empty">No uploaded recordings yet for this tower.</div>
          )}
          {segments.map((seg) => (
            <div className="rec-row" key={seg.segment_id}>
              <div className="rec-row-main">
                <div className="rec-row-title">CAM {String(seg.camera).padStart(2, '0')}</div>
                <div className="rec-row-time">{formatDateTimeUTC1(seg.started_at)}</div>
                <div className="rec-row-meta">{formatBytes(seg.size_bytes)} · {seg.filename}</div>
              </div>
              <div className="rec-row-actions">
                <button
                  type="button"
                  className="ctl-btn"
                  disabled={busyId === seg.segment_id}
                  onClick={() => {
                    setBusyId(seg.segment_id);
                    void play(seg.segment_id)
                      .then((url) => {
                        setPlayingUrl(url);
                        setPlayingLabel(`${towerLabel} · CAM ${String(seg.camera).padStart(2, '0')}`);
                      })
                      .finally(() => setBusyId(''));
                  }}
                >
                  PLAY
                </button>
                <button
                  type="button"
                  className="ctl-btn"
                  disabled={busyId === seg.segment_id}
                  onClick={() => {
                    setBusyId(seg.segment_id);
                    void download(seg).finally(() => setBusyId(''));
                  }}
                >
                  DOWNLOAD
                </button>
                <button
                  type="button"
                  className="ctl-btn rec-del"
                  disabled={busyId === seg.segment_id}
                  onClick={() => {
                    if (!window.confirm('Delete this recording from cloud storage?')) return;
                    setBusyId(seg.segment_id);
                    void remove(seg.segment_id).finally(() => setBusyId(''));
                  }}
                >
                  DELETE
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="rec-player-pane">
          <div className="rec-player-head">{playingLabel || 'Select a segment to play'}</div>
          {playingUrl ? (
            <video className="rec-player" controls autoPlay playsInline preload="metadata" src={playingUrl} />
          ) : (
            <div className="rec-player-empty">Select a segment to play</div>
          )}
        </div>
      </div>

      <div className="rec-foot">{session.customerId} · uploaded segments only · tenant isolated</div>
    </div>
  );
}
