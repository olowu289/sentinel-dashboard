import { useEffect, useMemo, useState } from 'react';
import { useTowerLive } from './useTowerLive';
import { useTower } from './towerContext';
import { openDetectionIncidentCount } from './util';
import DashboardConsole from './components/DashboardConsole';
import RecordingsView from './components/RecordingsView';
import SensorsView from './components/SensorsView';
import AlertsView from './components/AlertsView';
import Rail, { type RailView } from './components/Rail';
import TargetCueBanner from './components/TargetCueBanner';
import AiDetectionBanner from './components/AiDetectionBanner';
import AiTrackingBanner from './components/AiTrackingBanner';

/**
 * The console for the one tower this machine is cabled to.
 *
 * Replaces FleetApp. Everything fleet-shaped is gone - the tower drawer, the
 * tower menu, the selected-tower state, the per-view onSelectTower plumbing -
 * because a cable has already made the choice. What that removes is not just
 * UI: it removes a whole class of "which tower am I looking at" ambiguity
 * that a single-tower operator should never have had to carry.
 *
 * Grace period past the alert's own hold_seconds before the cue banner
 * clears, covering clock skew between the tower arming its hold timer and
 * this console receiving the alert.
 */
const TARGET_CUE_GRACE_MS = 2000;

function initials(label: string): string {
  const letters = label.replace(/[^a-zA-Z]/g, '');
  return (letters.slice(0, 2) || 'B').toUpperCase();
}

export default function TowerApp() {
  const { client } = useTower();
  const [view, setView] = useState<RailView>('live');
  const [now, setNow] = useState(() => Date.now());
  const [selectedCamId, setSelectedCamId] = useState('01');
  const [label, setLabel] = useState('TOWER');
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // The tower names itself. There is no fleet lookup to consult and nothing
  // to pick from - if this call fails we are not on the segment, which is a
  // different and more useful thing to say than "loading".
  useEffect(() => {
    let cancelled = false;
    client.config()
      .then((cfg) => {
        if (cancelled) return;
        setLabel((cfg.label || cfg.device_id || 'TOWER').toUpperCase());
        setConfigError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setConfigError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [client]);

  const live = useTowerLive('', selectedCamId, view === 'live');

  useEffect(() => {
    if (live.cameras.length && !live.cameras.some((c) => c.id === selectedCamId)) {
      setSelectedCamId(live.cameras[0].id);
    }
  }, [live.cameras, selectedCamId]);

  const alertBadge = useMemo(() => openDetectionIncidentCount(live.alerts), [live.alerts]);

  const cue = live.targetCueAlert;
  const cueActive = !!cue && now < cue.receivedAtMs + cue.holdSeconds * 1000 + TARGET_CUE_GRACE_MS;

  return (
    <div className="fleet-shell">
      <AiTrackingBanner />
      <AiDetectionBanner pushDown={cueActive} />
      {cueActive && cue && (
        <TargetCueBanner originLabel={cue.origin} towerLabel={label} camera={cue.camera} />
      )}
      <Rail
        view={view}
        onSelectView={setView}
        initials={initials(label)}
        alertBadge={alertBadge}
      />

      <div className="fleet-main">
        {configError && (
          <div className="login-error" style={{ margin: 16 }}>
            Tower unreachable — {configError}. Check the cable and that you are on the
            camera segment.
          </div>
        )}

        {view === 'live' && (
          <DashboardConsole
            deviceId=""
            deviceLabel={label}
            view={view}
            onSelectView={setView}
            selectedCamId={selectedCamId}
            onSelectCamId={setSelectedCamId}
            streams={live.streams}
            status={live.status}
            connected={live.connected}
            linkError={live.linkError}
            cameras={live.cameras}
            trackEvents={live.trackEvents}
            trackConnected={live.trackConnected}
            recording={live.recording}
            setRecordingLocal={live.setRecordingLocal}
          />
        )}

        {view === 'recordings' && (
          <RecordingsView view={view} onSelectView={setView} deviceLabel={label} />
        )}

        {view === 'sensors' && (
          <SensorsView
            view={view}
            onSelectView={setView}
            deviceLabel={label}
            status={live.status}
            streams={live.streams}
            cameras={live.cameras}
            connected={live.connected}
            linkError={live.linkError}
          />
        )}

        {view === 'alerts' && (
          <AlertsView
            view={view}
            onSelectView={setView}
            deviceLabel={label}
            alerts={live.alerts}
            connected={live.connected}
            linkError={live.linkError}
          />
        )}
      </div>
    </div>
  );
}
