import { useEffect, useState } from 'react';
import { formatClockUTC1, formatRelativeTime } from '../clock';
import { alertColor, linkStatusLabel } from '../util';
import { colors } from '../tokens';
import type { AlertEvent } from '../types';
import type { RailView } from './Rail';

interface Props {
  /** The tower's own name. There is exactly one - see TowerApp. */
  deviceLabel: string;
  view: RailView;
  onSelectView: (v: RailView) => void;
  alerts: AlertEvent[];
  connected: boolean;
  linkError: string;
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
  deviceLabel, view, onSelectView,
  alerts, connected, linkError,
}: Props) {
    const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const towerLabel = deviceLabel;
  const clock = formatClockUTC1(now);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand-group">
          <span className="wordmark">SENTINEL</span>
          <span className="wordmark-sub">{towerLabel}</span>
        </div>

        {/* Not a chooser any more - the dot is a link indicator only. */}
        <div className="tower-pill" title={towerLabel}>
          <span
            className={`tower-pill-dot${connected ? ' live' : ''}`}
            style={{ background: connected ? colors.online : colors.offline }}
          />
          <span className="tower-pill-label">{towerLabel}</span>
        </div>

        <nav className="seg-tabs" aria-label="Main sections">
          <button type="button" className={view === 'live' ? 'active' : ''} onClick={() => onSelectView('live')}>Live wall</button>
          <button type="button" className={view === 'recordings' ? 'active' : ''} onClick={() => onSelectView('recordings')}>Recordings</button>
        </nav>

        <div className="topbar-end-group">
          <div className="topbar-clock">
            <div className="topbar-clock-time">{clock}</div>
            <div className="topbar-clock-sub">UTC+1 · ALERTS</div>
          </div>
        </div>
      </header>


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
