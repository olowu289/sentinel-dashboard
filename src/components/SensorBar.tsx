import type { Sensor, SensorLevel } from '../types';
import { colors } from '../tokens';
import { levelColor } from '../util';

interface Props {
  sensors: Sensor[];
  deviceName: string;
  connected: boolean;
  linkError?: string;
  onOpenDetail: () => void;
}

function haloColor(level: SensorLevel): string {
  return level === 'crit' ? colors.haloAlert : level === 'warn' ? colors.haloWarn : colors.haloOk;
}

/**
 * Tower context bar — this tower's live vitals as a row of status chips, plus a
 * DETAILS button that navigates to the full Sensors page. Only sensors the
 * tower actually reports are shown as chips.
 */
export default function SensorBar({ sensors, deviceName, connected, linkError, onOpenDetail }: Props) {
  const chips = sensors.filter((s) => s.inBar && s.available !== false);

  return (
    <div className="sensorbar">
      <div className="sb-label">
        <span className="k">TOWER</span>
        <span className="v">{deviceName}</span>
      </div>

      {chips.map((s) => {
        const c = levelColor(s.level);
        return (
          <div key={s.key} className="chip">
            <span className="cdot" style={{ background: c, boxShadow: `0 0 0 3px ${haloColor(s.level)}` }} />
            <div className="meta">
              <span className="ck">{s.short}</span>
              <span className="cv" style={{ color: s.level === 'ok' ? colors.textStrong : c }}>
                {s.kind === 'numeric' ? (
                  <>{s.value}{s.unit && <u>{s.unit}</u>}</>
                ) : s.kind === 'state' ? (
                  s.state
                ) : null}
              </span>
            </div>
          </div>
        );
      })}

      <div className="sb-right">
        <span
          className={`sb-live${connected ? ' live' : ' down'}`}
          title={connected ? 'Platform API can reach this tower via the hub' : (linkError || 'Tower link lost — check hub proxy, VPN, or tower gateway')}
        >
          <span className="sb-live-dot" />
          {connected ? 'Link live' : 'Link offline'}
        </span>
        <button className="sb-more" onClick={onOpenDetail} aria-label="Open sensor detail panel" title="Sensor details">
          Details
        </button>
      </div>
    </div>
  );
}
