import type { AlertEvent } from './types';
import type { TrackEvent } from './trackLog';
import { formatDateTimeUTC1 } from './clock';

/**
 * One alert off the tower's SSE stream, shaped for the UI.
 *
 * Lived in session.ts, which is gone - it was never session logic, it just
 * happened to sit next to the platform types it borrowed. The shape is the
 * gateway's own alert envelope (see gateway.py's /api/events), which is the
 * same one the platform used to forward, so nothing about the mapping
 * changes - only where the alert came from.
 */
export interface RawAlert {
  nonce?: string;
  alert_type: string;
  severity?: string;
  timestamp_utc?: string | null;
  details?: Record<string, unknown>;
  device_id?: string;
}

export function alertToEvent(a: RawAlert): AlertEvent {
  const sev = (a.severity || '').toLowerCase();
  const level = sev === 'critical' ? 'bad' : sev === 'warning' ? 'warn' : 'good';
  const timestampUtc = a.timestamp_utc ?? null;
  return {
    id: a.nonce ?? `${a.alert_type}|${a.timestamp_utc}`,
    type: a.alert_type,
    level,
    timestampUtc,
    time: timestampUtc ? formatDateTimeUTC1(timestampUtc) : '',
    payload: a.details ?? {},
    deviceId: a.device_id,
  };
}

/**
 * A track event, promoted to an alert.
 *
 * The track log's severity dot has always claimed these rows "the Alerts view
 * also shows" - and they were never sent there. Two separate pipelines that
 * never met, with the log quietly asserting otherwise.
 *
 * Promoted rather than emitted twice by the tower: one message on the wire,
 * one source of truth. The log shows it as it happens; the alerts view keeps
 * it, with room for everything the log row cannot fit.
 *
 * Only warning and critical are promoted. Every detection produces info-level
 * TRK rows several times a second, and an alerts view that collected those
 * would be useless within a minute - which is the one thing an alerts view
 * cannot afford to be.
 */
export function trackEventToAlert(t: TrackEvent): AlertEvent {
  return {
    // Prefixed so it can never collide with a watchdog alert's nonce.
    id: `track:${t.id}`,
    type: 'track',
    level: t.severity === 'critical' ? 'bad' : 'warn',
    timestampUtc: t.ts,
    time: formatDateTimeUTC1(t.ts),
    // The FULL event. The log row is width-constrained and drops most of
    // this; the alerts view has the room, and this is where an operator goes
    // to ask "what actually happened", so nothing is thrown away here.
    payload: {
      kind: t.kind,
      camera: t.camera,
      detail: t.detail,
      bearing_deg: t.bearingDeg,
      elevation_deg: t.elevationDeg,
      range_m: t.rangeM,
      range_source: t.rangeSource,
      bearing_rate_deg_s: t.bearingRateDegS,
      camera_bearing_deg: t.cameraBearingDeg,
      conf: t.conf,
      label: t.label,
      frame_seq: t.frameSeq,
    },
  };
}
