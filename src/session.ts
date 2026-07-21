import type { PlatformAlert, Tower as ApiTower } from '@sentinel/sdk';
import type { Camera, Sensor, AlertEvent } from './types';
import { formatDateTimeUTC1 } from './clock';

export interface Session {
  baseUrl: string;
  apiKey: string;
  customerId: string;
}

const KEY = 'sentinel.dashboard.session';

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s.baseUrl || !s.apiKey || !s.customerId) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  sessionStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY);
}

export type TowerStatus = 'ONLINE' | 'STANDBY' | 'OFFLINE';

export interface FleetTower {
  id: string;
  name: string;
  location?: string;
  api: ApiTower;
  status: TowerStatus;
  cameras: Camera[];
  sensors: Sensor[];
  alerts: AlertEvent[];
  createdAt: number;
}

export function towerDisplayName(t: ApiTower): string {
  if (t.group_id) return t.group_id.replace(/_/g, ' ').toUpperCase();
  return t.device_id.replace(/_/g, ' ').toUpperCase();
}

export function alertToEvent(a: PlatformAlert): AlertEvent {
  const sev = (a.severity || '').toLowerCase();
  const level = sev === 'critical' ? 'bad' : sev === 'warning' ? 'warn' : 'good';
  const timestampUtc = a.timestamp_utc ?? null;
  const time = timestampUtc ? formatDateTimeUTC1(timestampUtc) : '';
  return {
    id: a.nonce ?? `${a.alert_type}|${a.timestamp_utc}`,
    type: a.alert_type,
    level,
    timestampUtc,
    time,
    payload: a.details ?? {},
    deviceId: a.device_id,
  };
}
