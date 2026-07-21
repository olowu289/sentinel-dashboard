import { useEffect, useMemo, useState } from 'react';
import { colors, font } from './tokens';
import { useFleet } from './useFleet';
import { usePlatform } from './platformContext';
import type { Tower } from './types';
import DashboardConsole from './components/DashboardConsole';
import RecordingsView from './components/RecordingsView';
import TowerDrawer from './components/TowerDrawer';
import TowerMenu from './components/TowerMenu';

type AppView = 'live' | 'recordings';

export default function FleetApp() {
  const { session, logout } = usePlatform();
  const { towers: fleetTowers, loading, error } = useFleet();
  const [selectedTowerId, setSelectedTowerId] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState<AppView>('live');
  const [now] = useState(() => Date.now());

  const towers: Tower[] = useMemo(() => fleetTowers.map((t) => ({
    ...t,
    cameras: t.cameras.length ? t.cameras : Array.from({ length: 4 }, (_, i) => ({
      id: String(i + 1).padStart(2, '0'),
      path: `cam${i + 1}`,
      label: `CAM ${String(i + 1).padStart(2, '0')}`,
      status: 'STANDBY' as const,
      az: 0, el: 0, zoom: 0, ptzLive: false,
      recording: false, recStart: null, homeAz: 0, homeEl: 0,
    })),
  })), [fleetTowers]);

  const selected = towers.find((t) => t.id === selectedTowerId) ?? towers[0];

  useEffect(() => {
    if (!selectedTowerId && towers[0]) setSelectedTowerId(towers[0].id);
  }, [towers, selectedTowerId]);

  const deviceLabel = selected ? selected.name : session.customerId.toUpperCase();

  return (
    <div className="fleet-shell">
      <div className="fleet-chrome">
        <button type="button" className="hamburger" onClick={() => setDrawerOpen(true)} aria-label="Open towers">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: colors.textFaint, letterSpacing: '.14em' }}>
          {session.customerId} · {towers.length} tower{towers.length === 1 ? '' : 's'}
        </span>
        <nav className="fleet-nav" aria-label="Main sections">
          <button type="button" className={view === 'live' ? 'active' : ''} onClick={() => setView('live')}>LIVE</button>
          <button type="button" className={view === 'recordings' ? 'active' : ''} onClick={() => setView('recordings')}>RECORDINGS</button>
        </nav>
        <button type="button" className="logout-btn" onClick={logout}>Sign out</button>
      </div>

      {towers.length > 1 && selected && (
        <TowerMenu towers={towers} selectedTowerId={selected.id} onSelect={setSelectedTowerId} />
      )}

      {loading && <div className="feed-loading">Loading fleet…</div>}
      {error && <div className="login-error" style={{ margin: 16 }}>{error}</div>}

      {selected && !loading && view === 'live' && (
        <DashboardConsole key={selected.id} deviceId={selected.id} deviceLabel={deviceLabel} />
      )}

      {selected && !loading && view === 'recordings' && (
        <RecordingsView
          key={`rec-${selected.id}`}
          towers={towers}
          selectedTowerId={selected.id}
          onSelectTower={setSelectedTowerId}
        />
      )}

      <TowerDrawer
        open={drawerOpen}
        towers={towers}
        selectedTowerId={selected?.id ?? ''}
        now={now}
        onClose={() => setDrawerOpen(false)}
        onSelect={(id: string) => { setSelectedTowerId(id); setDrawerOpen(false); }}
        onAdd={() => {}}
        onRemove={() => {}}
      />
    </div>
  );
}
