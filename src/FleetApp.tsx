import { useEffect, useMemo, useState } from 'react';
import { useFleet } from './useFleet';
import { usePlatform } from './platformContext';
import type { Tower } from './types';
import DashboardConsole from './components/DashboardConsole';
import RecordingsView from './components/RecordingsView';
import TowerDrawer from './components/TowerDrawer';
import TowerMenu from './components/TowerMenu';
import Rail, { type RailView } from './components/Rail';

function initials(label: string): string {
  const letters = label.replace(/[^a-zA-Z]/g, '');
  return (letters.slice(0, 2) || 'S').toUpperCase();
}

export default function FleetApp() {
  const { session } = usePlatform();
  const { towers: fleetTowers, loading, error } = useFleet();
  const [selectedTowerId, setSelectedTowerId] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState<RailView>('live');
  const [now, setNow] = useState(() => Date.now());
  /** Bumped by the rail's Sensors/Alerts icons to remotely open the sensor
   * panel (which lives inside DashboardConsole, since that's where the live
   * sensor/alert data is) even when the operator is on the Recordings view. */
  const [panelRequest, setPanelRequest] = useState<{ tick: number; focus: 'sensors' | 'alerts' } | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

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

  const openPanel = (focus: 'sensors' | 'alerts') => {
    setView('live');
    setPanelRequest((r) => ({ tick: (r?.tick ?? 0) + 1, focus }));
  };

  return (
    <div className="fleet-shell">
      <Rail
        view={view}
        onSelectView={setView}
        onOpenSensors={() => openPanel('sensors')}
        onOpenAlerts={() => openPanel('alerts')}
        initials={initials(deviceLabel)}
      />

      <div className="fleet-main">
        {towers.length > 1 && selected && (
          <TowerMenu towers={towers} selectedTowerId={selected.id} onSelect={setSelectedTowerId} />
        )}

        {loading && <div className="feed-loading">Loading fleet…</div>}
        {error && <div className="login-error" style={{ margin: 16 }}>{error}</div>}

        {selected && !loading && view === 'live' && (
          <DashboardConsole
            key={selected.id}
            deviceId={selected.id}
            deviceLabel={deviceLabel}
            view={view}
            onSelectView={setView}
            onOpenTowerMenu={() => setDrawerOpen(true)}
            openPanelSignal={panelRequest}
          />
        )}

        {selected && !loading && view === 'recordings' && (
          <RecordingsView
            key={`rec-${selected.id}`}
            towers={towers}
            selectedTowerId={selected.id}
            onSelectTower={setSelectedTowerId}
            view={view}
            onSelectView={setView}
            onOpenTowerMenu={() => setDrawerOpen(true)}
          />
        )}
      </div>

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
