import type { Tower, TowerStatus } from '../types';
import { colors } from '../tokens';
import { towerStatus } from '../store';

interface Props {
  towers: Tower[];
  selectedTowerId: string;
  onSelect: (id: string) => void;
}

const statusColor = (s: TowerStatus) =>
  s === 'ONLINE' ? colors.accent : s === 'STANDBY' ? colors.standby : colors.offline;

/**
 * Compact quick-switcher shown under the topbar tower pill. Lists every tower
 * with a status dot (green/amber/red); click to switch. The full drawer (with
 * filters / add / remove) still lives behind the hamburger menu.
 */
export default function TowerMenu({ towers, selectedTowerId, onSelect }: Props) {
  return (
    <div className="tower-menu" role="listbox" aria-label="Switch tower">
      {towers.map((t) => {
        const st = towerStatus(t);
        const active = t.id === selectedTowerId;
        return (
          <button
            key={t.id}
            role="option"
            aria-selected={active}
            className={`tower-menu-item${active ? ' selected' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            <span className="tmi-name">{t.name}</span>
            <span className="tmi-status" style={{ color: statusColor(st) }}>{st}</span>
            <span className="tmi-dot" style={{ background: statusColor(st), color: statusColor(st) }} title={st} />
          </button>
        );
      })}
    </div>
  );
}
