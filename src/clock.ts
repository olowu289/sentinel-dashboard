/** Fixed UTC+1 clock helpers for dashboard topbars. */
const UTC1_OFFSET_MS = 60 * 60 * 1000;

/** HH:MM:SS in UTC+1 (fixed offset, no DST). */
export function formatClockUTC1(ms: number): string {
  const d = new Date(ms + UTC1_OFFSET_MS);
  return d.toISOString().slice(11, 19);
}

/** Human-readable UTC+1 timestamp for recording lists. */
export function formatDateTimeUTC1(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const d = new Date(parsed + UTC1_OFFSET_MS);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC+1';
}

/** "2m ago" style relative time against a caller-supplied `nowMs` (no
 * internal ticking clock — re-renders naturally on every new alert/poll). */
export function formatRelativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const deltaSec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (deltaSec < 5) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
