import { useEffect, useMemo, useState } from 'react';
import { useFleet } from './useFleet';
import { useTowerLive } from './useTowerLive';
import { usePlatform } from './platformContext';
import { openDetectionIncidentCount } from './util';
import type { Tower } from './types';
import DashboardConsole from './components/DashboardConsole';
import RecordingsView from './components/RecordingsView';
import SensorsView from './components/SensorsView';
import AlertsView from './components/AlertsView';
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
  /** Which camera tile is under PTZ control — lives here (not inside
   * DashboardConsole) because useTowerLive needs it too, for the
   * selected-camera PTZ poll below. */
  const [selectedCamId, setSelectedCamId] = useState('01');

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

  // One shared connection for the selected tower, used by Live wall/Sensors/
  // Alerts alike — see useTowerLive's own comment for why this lives here
  // instead of inside each view. PTZ position polling only runs while the
  // Live wall is actually on screen.
  const live = useTowerLive(selected?.id ?? '', selectedCamId, view === 'live');

  useEffect(() => {
    if (live.cameras.length && !live.cameras.some((c) => c.id === selectedCamId)) {
      setSelectedCamId(live.cameras[0].id);
    }
  }, [live.cameras, selectedCamId]);

  const alertBadge = useMemo(() => openDetectionIncidentCount(live.alerts), [live.alerts]);

  return (
    <div className="fleet-shell">
      <Rail
        view={view}
        onSelectView={setView}
        onOpenTowerMenu={() => setDrawerOpen(true)}
        initials={initials(deviceLabel)}
        alertBadge={alertBadge}
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
            selectedCamId={selectedCamId}
            onSelectCamId={setSelectedCamId}
            streams={live.streams}
            status={live.status}
            connected={live.connected}
            linkError={live.linkError}
            cameras={live.cameras}
            hlsUrls={live.hlsUrls}
            webrtcUrls={live.webrtcUrls}
            recording={live.recording}
            setRecordingLocal={live.setRecordingLocal}
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

        {selected && !loading && view === 'sensors' && (
          <SensorsView
            key={`sensors-${selected.id}`}
            towers={towers}
            selectedTowerId={selected.id}
            onSelectTower={setSelectedTowerId}
            view={view}
            onSelectView={setView}
            onOpenTowerMenu={() => setDrawerOpen(true)}
            status={live.status}
            streams={live.streams}
            cameras={live.cameras}
            connected={live.connected}
            linkError={live.linkError}
          />
        )}

        {selected && !loading && view === 'alerts' && (
          <AlertsView
            key={`alerts-${selected.id}`}
            towers={towers}
            selectedTowerId={selected.id}
            onSelectTower={setSelectedTowerId}
            view={view}
            onSelectView={setView}
            onOpenTowerMenu={() => setDrawerOpen(true)}
            alerts={live.alerts}
            connected={live.connected}
            linkError={live.linkError}
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
