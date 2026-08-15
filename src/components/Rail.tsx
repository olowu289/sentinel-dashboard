import type { ReactNode } from 'react';
import { colors, font } from '../tokens';

export type RailView = 'live' | 'recordings' | 'sensors' | 'alerts';

interface Props {
  view: RailView;
  onSelectView: (v: RailView) => void;
  initials: string;
  /** Open (unresolved) detection incidents — small count badge on the Alerts icon. */
  alertBadge?: number;
  /** Settings is NOT a RailView: it opens a floating panel over whatever is on
   *  screen rather than replacing it. An operator changing a setting should
   *  not have to leave the wall to do it. */
  onOpenSettings: () => void;
}

function NavIcon({ active, title, onClick, children }: {
  active: boolean; title: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rail-nav-btn${active ? ' active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const iconProps = {
  width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none' as const,
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** Left icon rail — persistent app chrome (logo, section nav, avatar). */
export default function Rail({
  view, onSelectView, initials, alertBadge = 0, onOpenSettings,
}: Props) {
  return (
    <div className="rail">
      <button
        type="button"
        className="rail-logo"
        style={{ fontFamily: font.display }}
        aria-label="Towers"
        title="Towers"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>

      <NavIcon active={view === 'live'} title="Live wall" onClick={() => onSelectView('live')}>
        <svg {...iconProps}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      </NavIcon>

      <NavIcon active={view === 'recordings'} title="Recordings" onClick={() => onSelectView('recordings')}>
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      </NavIcon>

      <NavIcon active={view === 'sensors'} title="Sensors" onClick={() => onSelectView('sensors')}>
        <svg {...iconProps}>
          <path d="M2 12h4l2.5-7 5 14 2.5-7H22" />
        </svg>
      </NavIcon>

      <NavIcon
        active={view === 'alerts'}
        title={`Alerts${alertBadge > 0 ? ` (${alertBadge} open)` : ''}`}
        onClick={() => onSelectView('alerts')}
      >
        <svg {...iconProps}>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {alertBadge > 0 && <span className="rail-badge">{alertBadge > 9 ? '9+' : alertBadge}</span>}
      </NavIcon>

      <div style={{ flex: 1 }} />

      {/* Not a NavIcon: it is not a view, and showing it as "active" would
          imply the wall had been left behind. It has not — it is underneath. */}
      <button
        type="button"
        className="rail-nav-btn"
        title="Settings"
        aria-label="Settings"
        aria-haspopup="dialog"
        onClick={onOpenSettings}
      >
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <div className="rail-avatar" title={initials} style={{ color: colors.textDim }}>{initials}</div>
    </div>
  );
}
