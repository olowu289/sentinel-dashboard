import { useEffect, useMemo, useState } from 'react';
import { colors, font } from '../tokens';
import { formatClockUTC1, formatDateTimeUTC1, formatBytes } from '../clock';
import { usePlatform } from '../platformContext';
import { useRecordings } from '../useRecordings';
import { formatApiError } from '../util';
import type { Tower } from '../types';

const PAGE_SIZE = 24;

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
  const [actionError, setActionError] = useState('');
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const deviceId = selectedTowerId || undefined;
  const { segments, retentionDays, loading, error, refresh, play, download, remove } = useRecordings(
    deviceId,
    { camera, enabled: !!deviceId },
  );

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setPage(0);
    setActionError('');
  }, [deviceId, camera]);

  const pageCount = Math.max(1, Math.ceil(segments.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => segments.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [segments, safePage],
  );

  const towerLabel = useMemo(
    () => towers.find((t) => t.id === selectedTowerId)?.name ?? selectedTowerId,
    [towers, selectedTowerId],
  );

  const clock = formatClockUTC1(now);
  const rangeStart = segments.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(segments.length, (safePage + 1) * PAGE_SIZE);
  const bannerError = actionError || error;

  return (
    <div className="recordings-view">
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

      {bannerError && <div className="login-error rec-error">{bannerError}</div>}

      <div className="rec-layout">
        <aside className="rec-list-pane">
          <div className="rec-list-head">
            <span>{towerLabel}</span>
            <span>{segments.length} total</span>
          </div>
          <div className="rec-list-body">
            {segments.length === 0 && !loading && (
              <div className="rec-empty">No uploaded recordings yet for this tower.</div>
            )}
            {pageItems.map((seg) => (
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
                        .catch((e: unknown) => {
                          setPlayingUrl(null);
                          setActionError(formatApiError(e, 'Could not play recording'));
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
                      void download(seg)
                        .catch((e: unknown) => setActionError(formatApiError(e, 'Could not download recording')))
                        .finally(() => setBusyId(''));
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
                      void remove(seg.segment_id)
                        .catch((e: unknown) => setActionError(formatApiError(e, 'Could not delete recording')))
                        .finally(() => setBusyId(''));
                    }}
                  >
                    DELETE
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="rec-pager">
            <button
              type="button"
              className="ctl-btn"
              disabled={safePage <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              PREV
            </button>
            <span className="rec-pager-meta">
              {rangeStart}–{rangeEnd} / {segments.length} · page {safePage + 1}/{pageCount}
            </span>
            <button
              type="button"
              className="ctl-btn"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              NEXT
            </button>
          </div>
        </aside>

        <section className="rec-player-pane">
          <div className="rec-player-head">{playingLabel || 'Select a segment to play'}</div>
          {playingUrl ? (
            <video className="rec-player" controls autoPlay playsInline preload="metadata" src={playingUrl} />
          ) : (
            <div className="rec-player-empty">Select a segment to play</div>
          )}
        </section>
      </div>

      <div className="rec-foot">{session.customerId} · uploaded segments only · tenant isolated</div>
    </div>
  );
}
