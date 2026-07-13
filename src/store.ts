import type { Tower, TowerStatus, Sensor, SensorLevel } from './types';
import { colors } from './tokens';

const RANK: Record<SensorLevel, number> = { ok: 0, warn: 1, crit: 2 };

export function towerStatus(t: Tower): TowerStatus {
  if (t.cameras.some((c) => c.status === 'ONLINE')) return 'ONLINE';
  if (t.cameras.some((c) => c.status === 'STANDBY')) return 'STANDBY';
  return 'OFFLINE';
}

export function towerHealth(t: Tower): { level: SensorLevel; label: string } {
  let worst: SensorLevel = 'ok';
  let ws: Sensor | undefined;
  for (const s of t.sensors) {
    if (RANK[s.level] > RANK[worst]) { worst = s.level; ws = s; }
  }
  if (worst === 'ok' || !ws) return { level: 'ok', label: 'OK' };
  const label = ws.kind === 'numeric' ? `${ws.short} ${ws.value}${ws.unit}` : ws.short;
  return { level: worst, label };
}

export function levelColor(level: SensorLevel): string {
  return level === 'crit' ? colors.offline : level === 'warn' ? colors.standby : colors.accent;
}
