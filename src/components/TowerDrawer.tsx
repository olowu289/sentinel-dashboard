import { useMemo, useState } from 'react';
import type { Tower, TowerStatus } from '../types';
import { colors } from '../tokens';
import { levelColor, towerHealth, towerStatus } from '../store';

interface Props {
  open: boolean;
  towers: Tower[];
  selectedTowerId: string;
  now: number;
  onClose: () => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

const STATUS_OPTS: Array<TowerStatus | 'ALL'> = ['ALL', 'ONLINE', 'STANDBY', 'OFFLINE'];

const statusColor = (s: TowerStatus) =>
  s === 'ONLINE' ? colors.accent : s === 'STANDBY' ? colors.standby : colors.offline;

function fmtAgo(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function TowerDrawer({
  open,
  towers,
  selectedTowerId,
  now,
  onClose,
  onSelect,
  onAdd,
  onRemove,
}: Props) {
  const [status, setStatus] = useState<TowerStatus | 'ALL'>('ALL');
  const [location, setLocation] = useState<string>('ALL');
  const [query, setQuery] = useState('');

  const locations = useMemo(() => {
    const set = new Set<string>();
    towers.forEach((t) => t.location && set.add(t.location));
    return Array.from(set).sort();
  }, [towers]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return towers
      .map((t) => ({ t, st: towerStatus(t) }))
      .filter(({ t, st }) => {
        if (status !== 'ALL' && st !== status) return false;
        if (location !== 'ALL' && t.location !== location) return false;
        if (q && !t.name.toLowerCase().includes(q)) return false;
        return true;
      });
  }, [towers, status, location, query]);

  return (
    <div className={`drawer-root${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="drawer-backdrop" onClick={onClose} />

      <aside className="drawer" role="dialog" aria-label="Towers" aria-modal="true">
        {/* header */}
        <div className="drawer-head">
          <button className="drawer-icon-btn" onClick={onClose} aria-label="Close towers panel" title="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span className="drawer-title">TOWERS</span>
          <button className="drawer-icon-btn add" onClick={onAdd} aria-label="Add tower" title="Add tower">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        {/* filters */}
        <div className="drawer-filters">
          <select className="drawer-select" value={status} onChange={(e) => setStatus(e.target.value as TowerStatus | 'ALL')} aria-label="Filter by status">
            {STATUS_OPTS.map((s) => (
              <option key={s} value={s}>{s === 'ALL' ? 'All Status' : s}</option>
            ))}
          </select>
          <select className="drawer-select" value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Filter by location">
            <option value="ALL">All Locations</option>
            {locations.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
        <input
          className="drawer-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search towers…"
          aria-label="Search towers by name"
        />

        {/* list */}
        <div className="drawer-list">
          {rows.length === 0 && <div className="drawer-empty">No towers match.</div>}
          {rows.map(({ t, st }) => (
            <div
              key={t.id}
              className={`tower-row${t.id === selectedTowerId ? ' selected' : ''}`}
              onClick={() => onSelect(t.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(t.id); }
              }}
            >
              <div className="tower-row-main">
                <div className="tower-row-name">{t.name}</div>
                <div className="tower-row-sub">
                  {t.cameras.length} cameras{t.location ? ` · ${t.location}` : ''} · added {fmtAgo(t.createdAt, now)}
                </div>
              </div>
              <div className="tower-flags">
                <span className="tower-badge" style={{ color: statusColor(st), borderColor: statusColor(st) }}>
                  <span className="tower-dot" style={{ background: statusColor(st) }} />
                  {st}
                </span>
                {(() => {
                  const h = towerHealth(t);
                  return <span className={`health ${h.level}`}><span className="hd" style={{ background: levelColor(h.level) }} />{h.label}</span>;
                })()}
              </div>
              <button
                className="tower-remove"
                onClick={(e) => { e.stopPropagation(); onRemove(t.id); }}
                aria-label={`Remove ${t.name}`}
                title="Remove tower"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        <div className="drawer-foot">{towers.length} tower{towers.length === 1 ? '' : 's'}</div>
      </aside>
    </div>
  );
}
