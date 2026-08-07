import { useEffect, useRef, useState } from 'react';
import type { AlertEvent, Sensor } from '../types';
import { alertColor, levelColor } from '../util';
import { colors } from '../tokens';
import { formatRelativeTime } from '../clock';

interface Props {
  open: boolean;
  deviceName: string;
  sensors: Sensor[];
  alerts: AlertEvent[];
  connected: boolean;
  /** Which section to scroll into view when the panel opens. */
  initialFocus?: 'sensors' | 'alerts';
  onClose: () => void;
}

const badgeText = (s: Sensor) => (s.available === false ? 'N/A' : s.level === 'crit' ? 'ALERT' : s.level === 'warn' ? 'WARN' : 'OK');
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

function Card({ s }: { s: Sensor }) {
  const naCard = s.available === false;
  const c = naCard ? '#4a5762' : levelColor(s.level);
  return (
    <div className={`mcard ${naCard ? 'na' : s.level}`}>
      <div className="mc-top">
        <span className="mc-k">{s.label}</span>
        <span className="mc-badge" style={{ color: c, borderColor: c }}>{badgeText(s)}</span>
      </div>

      {naCard ? (
        <div className="mc-v mc-na">—</div>
      ) : (
        <>
          {s.kind === 'numeric' && (
            <>
              <div className="mc-v">{s.value}{s.unit && <u>{s.unit}</u>}</div>
              {s.max != null && (
                <div className="mc-bar">
                  <span style={{
                    width: `${clampPct((s.value / s.max) * 100)}%`,
                    background: s.barGradient ? `linear-gradient(90deg, ${levelColor('ok')}, ${levelColor('warn')})` : c,
                  }} />
                </div>
              )}
            </>
          )}
          {s.kind === 'state' && <div className="mc-v">{s.state}</div>}
          {s.kind === 'list' && (
            <div className="mc-list">
              {s.items.map((it) => (
                <div className="lr" key={it.label}>
                  <span>{it.label}</span>
                  <span className={`s ${it.up ? 'live' : 'down'}`}><span className="d" />{it.up ? 'live' : 'down'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {s.detail && !naCard && <div className="mc-sub">{s.detail}</div>}
    </div>
  );
}

/** Detection alerts (from the AI bridge's raise/refresh/clear incidents)
 * get a dedicated layout — class + camera + confidence + relative time,
 * raised/refreshed bold/accented, cleared dimmed. Everything else (health/
 * watchdog alerts) keeps the generic type+time+JSON row below. */
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

export default function SensorPanel({ open, deviceName, sensors, alerts, connected, initialFocus, onClose }: Props) {
  const alertsRef = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (open && initialFocus === 'alerts') {
      alertsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [open, initialFocus]);

  // Relative-time labels ("2m ago") only need to tick while the panel is
  // actually visible.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  return (
    <div className={`mon-root${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="mon-backdrop" onClick={onClose} />
      <div className="mon" role="dialog" aria-modal="true" aria-label={`${deviceName} sensor monitor`}>
        <div className="mon-top">
          <div className="mon-brand">{deviceName}<small>SENSOR MONITOR</small></div>
          <span className="mon-conn">
            <span className="d" style={{ background: connected ? '#ffffff' : '#FF5A5A', boxShadow: `0 0 8px ${connected ? '#ffffff' : '#FF5A5A'}` }} />
            {connected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
          <button className="mon-close" onClick={onClose} aria-label="Close monitor" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mon-body">
          <div className="cards">
            {sensors.map((s) => <Card key={s.key} s={s} />)}
          </div>

          <div className="alerts" ref={alertsRef}>
            <div className="al-head"><span className="t">LIVE ALERTS</span><span className="al-count">{alerts.length}</span></div>
            <div className="al-list">
              {alerts.length === 0 && <div className="al-empty">No active alerts.</div>}
              {alerts.map((a) => <AlertRow key={a.id} a={a} nowMs={nowMs} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
