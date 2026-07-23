import { colors } from './tokens';
import type { AlertLevel, Sensor, SensorLevel } from './types';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Prefer SDK / fetch errors that carry a machine `code`. */
export function errCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && c) return c;
  }
  return undefined;
}

const FRIENDLY: Record<string, string> = {
  unauthorized: 'Invalid API key or access denied',
  not_found: 'Not found',
  tower_not_enrolled: 'Tower has not finished enrollment yet',
  hub_not_provisioned: 'Customer hub is not provisioned in the registry',
  hub_proxy_misconfigured: 'Control plane is missing hub proxy credentials',
  hub_proxy_unreachable: 'Cannot reach the customer hub proxy (tower may still be online)',
  hub_proxy_timeout: 'Hub proxy timed out waiting for the tower',
  hub_proxy_auth_failed: 'Hub rejected the control-plane proxy token',
  hub_hls_unreachable: 'Cannot reach hub live-video service (tower may still be online)',
  hub_mediamtx_unreachable: 'Hub MediaMTX is not serving live video',
  tower_offline: 'Tower gateway did not respond over the VPN',
  tower_unreachable: 'Tower gateway is unreachable over the VPN',
  tower_timeout: 'Tower gateway timed out',
  tower_error: 'Tower returned an error',
  registry_unavailable: 'Control-plane database is unavailable',
  s3_not_configured: 'Cloud storage is not configured on the control plane',
  s3_error: 'Cloud storage request failed',
  stream_starting: 'Live stream is still starting — retry shortly',
  conflict: 'Conflict with an existing resource',
  invalid_request: 'Invalid request',
};

/**
 * User-facing error: short friendly text when we know the code, always keeping
 * the API's specific message so the failing hop stays visible.
 */
export function formatApiError(e: unknown, fallback = 'Something went wrong'): string {
  const code = errCode(e);
  const message = errMsg(e).trim();
  if (!code && /aborted|AbortError|timed out|TimeoutError/i.test(message)) {
    return 'Request timed out — check network or control-plane URL';
  }
  const friendly = code ? FRIENDLY[code] : undefined;
  if (friendly && message && message !== friendly && !message.startsWith(friendly)) {
    return `${friendly}. ${message}`;
  }
  if (friendly) return friendly;
  return message || fallback;
}

export function linkStatusLabel(connected: boolean, linkError?: string): string {
  if (connected) return 'Tower link OK';
  if (linkError) return linkError;
  return 'Tower link lost — check hub proxy, VPN, or tower gateway';
}

const RANK: Record<SensorLevel, number> = { ok: 0, warn: 1, crit: 2 };

/** Worst level across the sensors that are actually available on this tower. */
export function worstLevel(sensors: Sensor[]): SensorLevel {
  return sensors.reduce<SensorLevel>(
    (w, s) => (s.available === false ? w : RANK[s.level] > RANK[w] ? s.level : w),
    'ok',
  );
}

/** Worst sensor state + a short label for the header health chip. */
export function health(sensors: Sensor[]): { level: SensorLevel; label: string } {
  let worst: SensorLevel = 'ok';
  let ws: Sensor | undefined;
  for (const s of sensors) {
    if (s.available === false) continue;
    if (RANK[s.level] > RANK[worst]) { worst = s.level; ws = s; }
  }
  if (worst === 'ok' || !ws) return { level: 'ok', label: 'OK' };
  const label = ws.kind === 'numeric' ? `${ws.short} ${ws.value}${ws.unit}` : ws.short;
  return { level: worst, label };
}

export function levelColor(level: SensorLevel): string {
  return level === 'crit' ? colors.offline : level === 'warn' ? colors.standby : colors.accent;
}

export function alertColor(level: AlertLevel): string {
  return level === 'bad' ? colors.offline : level === 'warn' ? colors.standby : colors.accent;
}
