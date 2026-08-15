import { useEffect, useState } from 'react';
import { formatClockUTC1, formatRelativeTime } from '../clock';
import { alertColor, linkStatusLabel } from '../util';
import { colors } from '../tokens';
import {
  formatBearing, formatElevation, formatRange, formatRate, isMeasuredRange,
  rangeTitle, rateTitle, type RangeSource, type TrackEventKind,
} from '../trackLog';
import type { AlertEvent } from '../types';
import type { RailView } from './Rail';
import Wordmark from './Wordmark';

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

/** What each track event kind MEANS, spelled out. The log has room for a
 *  four-letter code and nothing else; this view has room to say it plainly,
 *  and an operator reading back through an incident should not have to have
 *  memorised the vocabulary. */
const KIND_MEANING: Record<TrackEventKind, string> = {
  CUE: 'External bearing received — the tower was told where to look',
  SLEW: 'Driving toward a cue',
  ACQ: 'Target acquired on camera',
  TRK: 'Tracking',
  LOST: 'Target lost',
  HANDOFF: 'Leaving this camera’s sector',
  LIMIT: 'The mount cannot follow any further',
  HOME: 'Returning to rest position',
  ALERT: 'Crossed the alert threshold',
  DISARM: 'Tracking switched off mid-move',
};

/**
 * A track event in the alerts view — the same event the log showed, with the
 * room the log did not have.
 *
 * The log row is a scannable line in a 440px rail. This is the place someone
 * comes to ask what actually happened, so every number the tower knew at that
 * moment is here, with its units and its caveats intact.
 */
function TrackAlertRow({ a, nowMs }: { a: AlertEvent; nowMs: number }) {
  const p = a.payload;
  const kind = String(p.kind ?? 'TRK') as TrackEventKind;
  const camera = p.camera == null ? 'RF' : `CAM ${String(p.camera).padStart(2, '0')}`;
  const bearing = typeof p.bearing_deg === 'number' ? p.bearing_deg : null;
  const elevation = typeof p.elevation_deg === 'number' ? p.elevation_deg : null;
  const rangeM = typeof p.range_m === 'number' ? p.range_m : null;
  const rangeSrc = (p.range_source ?? null) as RangeSource | null;
  const rate = typeof p.bearing_rate_deg_s === 'number' ? p.bearing_rate_deg_s : null;
  const camBearing = typeof p.camera_bearing_deg === 'number' ? p.camera_bearing_deg : null;
  const conf = typeof p.conf === 'number' ? p.conf : null;
  const label = typeof p.label === 'string' ? p.label : null;
  const frameSeq = typeof p.frame_seq === 'number' ? p.frame_seq : null;
  // alertColor is the existing level->colour mapping used by every other row
  // here; a second mapping would drift from it the first time either changed.
  const accent = alertColor(a.level);

  return (
    <div className="ai trk" style={{ borderLeftColor: accent }}>
      <div className="ai-top">
        <span className="ai-type" style={{ color: accent }}>
          {kind}<span className="trk-cam">{camera}</span>
          {label && <span className="trk-cam">{label.toUpperCase()}</span>}
          {conf != null && <span className="trk-cam">{Math.round(conf * 100)}%</span>}
        </span>
        <span className="ai-time" title={a.time}>{formatRelativeTime(a.timestampUtc, nowMs)}</span>
      </div>

      <div className="trk-mean">{KIND_MEANING[kind] ?? 'Track event'}</div>

      {/* Where it was. Dashes, not zeros, for anything the tower did not
          know — a zero bearing is a real direction and must never stand in
          for a missing one. */}
      <div className="trk-grid">
        <div><span>BEARING</span><b>{formatBearing(bearing)}</b></div>
        <div><span>ELEVATION</span><b>{formatElevation(elevation)}</b></div>
        <div title={rangeTitle(rangeM, rangeSrc)}>
          <span>RANGE</span>
          <b className={rangeM != null && !isMeasuredRange(rangeSrc) ? 'est' : ''}>
            {formatRange(rangeM, rangeSrc)}
          </b>
        </div>
        <div title={rateTitle(rate)}>
          <span>RATE</span><b>{rate == null ? '—' : `${formatRate(rate)}°/s`}</b>
        </div>
      </div>

      {/* Range provenance, spelled out. "~412m" in the log says an estimate;
          here there is room to say WHY it is one, which is what decides
          whether anyone should act on it. */}
      {rangeM != null && !isMeasuredRange(rangeSrc) && (
        <div className="trk-caveat">
          Range is an estimate ({String(rangeSrc ?? 'source unrecorded').replace('_', ' ')}) —
          not measured. The tower cannot measure distance from a single camera.
        </div>
      )}

      {p.detail ? <div className="ai-json">{String(p.detail)}</div> : null}

      {/* Provenance. Where the CAMERA was aimed is a different fact from where
          the target was — they differ by up to half a field of view — and the
          frame number ties this line to one specific picture on the annotated
          stream, which is what makes a disagreement checkable rather than
          arguable. */}
      {(camBearing != null || frameSeq != null) && (
        <div className="trk-prov">
          {camBearing != null && <span>camera aimed {formatBearing(camBearing)}</span>}
          {frameSeq != null && <span>frame #{frameSeq}</span>}
        </div>
      )}
    </div>
  );
}

function AlertRow({ a, nowMs }: { a: AlertEvent; nowMs: number }) {
  if (a.type === 'track') return <TrackAlertRow a={a} nowMs={nowMs} />;
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
