import { useMemo, useState, useEffect } from 'react';
import type { StreamsResponse } from '@sentinel/sdk';
import type { StatusResponse } from '../apiTypes';
import { formatClockUTC1 } from '../clock';
import { buildSensors } from '../sensors';
import { linkStatusLabel } from '../util';
import { colors } from '../tokens';
import type { Camera, Sensor } from '../types';
import type { RailView } from './Rail';
import Wordmark from './Wordmark';

interface Props {
  /** The tower's own name. There is exactly one - see TowerApp. */
  deviceLabel: string;
  view: RailView;
  onSelectView: (v: RailView) => void;
  status: StatusResponse | null;
  streams: StreamsResponse | null;
  cameras: Camera[];
  connected: boolean;
  linkError: string;
}

const badgeText = (s: Sensor) => (s.available === false ? 'N/A' : s.level === 'crit' ? 'ALERT' : s.level === 'warn' ? 'WARN' : 'OK');
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

function levelColor(level: Sensor['level']): string {
  return level === 'crit' ? colors.offline : level === 'warn' ? colors.standby : colors.online;
}

function SensorCard({ s }: { s: Sensor }) {
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

/**
 * Dedicated Sensors page (all sensors for the tower currently active on the
 * dashboard) — a real view alongside Live wall/Recordings, not a modal.
 * Mirrors RecordingsView's shape (own topbar + tower switcher); live data
 * comes from FleetApp's single shared useTowerLive instance as props, not
 * a hook call here — see useTowerLive's own comment for why.
 */
export default function SensorsView({
  deviceLabel, view, onSelectView,
  status, streams, cameras, connected, linkError,
}: Props) {
    const [now, setNow] = useState(() => Date.now());
  const sensors = useMemo(() => buildSensors(status, streams, cameras), [status, streams, cameras]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const towerLabel = deviceLabel;
  const clock = formatClockUTC1(now);

  return (
    <div className="app">
      <header className="topbar">
        <Wordmark />

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
            <div className="topbar-clock-sub">UTC+1 · SENSORS</div>
          </div>
        </div>
      </header>


      {!connected && <div className="login-error" style={{ margin: 16 }}>{linkStatusLabel(connected, linkError)}</div>}

      <div className="sensors-body">
        <div className="cards">
          {sensors.map((s) => <SensorCard key={s.key} s={s} />)}
        </div>
      </div>
    </div>
  );
}
