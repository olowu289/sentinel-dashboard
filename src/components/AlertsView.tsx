import { useEffect, useMemo, useState } from 'react';
import { formatClockUTC1, formatRelativeTime } from '../clock';
import { usePlatform } from '../platformContext';
import { useTowerLive } from '../useTowerLive';
import { alertColor, linkStatusLabel, openDetectionIncidentCount } from '../util';
import { colors } from '../tokens';
import type { AlertEvent, Tower } from '../types';
import type { RailView } from './Rail';

interface Props {
  towers: Tower[];
  selectedTowerId: string;
  onSelectTower: (id: string) => void;
  view: RailView;
  onSelectView: (v: RailView) => void;
  onOpenTowerMenu: () => void;
  onAlertBadge?: (n: number) => void;
}

/** Detection alerts (raise/refresh/clear incidents) get a dedicated layout;
 * everything else (health/watchdog alerts) keeps the generic type+time+JSON
 * row. Same rendering as the old SensorPanel modal, just full-width now. */
function DetectionAlertRow({ a, nowMs }: { a: AlertEvent; nowMs: number }) {
  const p = a.payload;
  const state = String(p.state ?? '');
  const cleared = state === 'cleared';
  const className = String(p.class_name ?? 'object');
  const camera = p.camera != null ? String(p.camera) : '';
  const confidence = typeof p.confidence === 'number' ? `${Math.round(p.confidence * 100)}%` : '';
  const color = cleared ? colors.textCaption : colors.accentText;
  return (
    <div className="ai" style={{ borderLeftColor: cleared ? colors.line2 : colors.accent }}>
      <div className="ai-top">
        <span className="ai-type" style={{ color, fontWeight: cleared ? 400 : 700 }}>
          {className.toUpperCase()}{camera && ` · ${camera.toUpperCase()}`}{confidence && ` · ${confidence}`}
        </span>
        <span className="ai-time">{formatRelativeTime(a.timestampUtc, nowMs)}</span>
      </div>
      <div className="ai-json" style={{ color: cleared ? colors.textCaption : colors.textDim }}>
        {state.toUpperCase()}
      </div>
    </div>
  );
}

function AlertRow({ a, nowMs }: { a: AlertEvent; nowMs: number }) {
  if (a.type === 'detection') return <DetectionAlertRow a={a} nowMs={nowMs} />;
  const hasPayload = a.payload && Object.keys(a.payload).length > 0;
  return (
    <div className="ai" style={{ borderLeftColor: alertColor(a.level) }}>
      <div className="ai-top">
        <span className="ai-type" style={{ color: alertColor(a.level) }}>{a.type}</span>
        <span className="ai-time">{a.time}</span>
      </div>
      {hasPayload && <div className="ai-json">{JSON.stringify(a.payload)}</div>}
    </div>
  );
}

/**
 * Dedicated Alerts page — alerts only, no sensor cards mixed in, for the
 * tower currently active on the dashboard. Same top-level-view shape as
 * SensorsView/RecordingsView.
 */
export default function AlertsView({
  towers, selectedTowerId, onSelectTower, view, onSelectView, onOpenTowerMenu, onAlertBadge,
}: Props) {
  const { session, logout } = usePlatform();
  const [now, setNow] = useState(() => Date.now());
  const { alerts, connected, linkError } = useTowerLive(selectedTowerId);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => { onAlertBadge?.(openDetectionIncidentCount(alerts)); }, [alerts, onAlertBadge]);

  const towerLabel = useMemo(
    () => towers.find((t) => t.id === selectedTowerId)?.name ?? selectedTowerId,
    [towers, selectedTowerId],
  );
  const clock = formatClockUTC1(now);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand-group">
          <span className="wordmark">SENTINEL</span>
          <span className="wordmark-sub">{session.customerId}</span>
        </div>

        <button type="button" className="tower-pill" onClick={onOpenTowerMenu} title={towerLabel}>
          <span
            className={`tower-pill-dot${connected ? ' live' : ''}`}
            style={{ background: connected ? colors.online : colors.offline }}
          />
          <span className="tower-pill-label">{towerLabel}</span>
          <span className="tower-pill-caret">▾</span>
        </button>

        <nav className="seg-tabs" aria-label="Main sections">
          <button type="button" className={view === 'live' ? 'active' : ''} onClick={() => onSelectView('live')}>Live wall</button>
          <button type="button" className={view === 'recordings' ? 'active' : ''} onClick={() => onSelectView('recordings')}>Recordings</button>
        </nav>

        <div className="topbar-end-group">
          <div className="topbar-clock">
            <div className="topbar-clock-time">{clock}</div>
            <div className="topbar-clock-sub">UTC+1 · ALERTS</div>
          </div>
          <div className="topbar-divider" />
          <button type="button" className="logout-btn" onClick={logout}>Sign out</button>
        </div>
      </header>

      {towers.length > 1 && (
        <div className="rec-toolbar">
          <label className="rec-filter">
            <span>TOWER</span>
            <select value={selectedTowerId} onChange={(e) => onSelectTower(e.target.value)}>
              {towers.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {!connected && <div className="login-error" style={{ margin: 16 }}>{linkStatusLabel(connected, linkError)}</div>}

      <div className="alerts-body">
        <div className="alerts">
          <div className="al-head"><span className="t">LIVE ALERTS</span><span className="al-count">{alerts.length}</span></div>
          <div className="al-list">
            {alerts.length === 0 && <div className="al-empty">No active alerts.</div>}
            {alerts.map((a) => <AlertRow key={a.id} a={a} nowMs={now} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
