import type { AlertEvent } from './types';
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
