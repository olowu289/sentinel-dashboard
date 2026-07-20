import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colors, font } from '../tokens';
import { errMsg } from '../util';
import { buildSensors } from '../sensors';
import { usePlatform } from '../platformContext';
import { useTowerLive } from '../useTowerLive';
import { formatZoom } from '../ptzMetrics';
import TowerFeed from './TowerFeed';
import PtzPad, { type PanDir } from './PtzPad';
import PtzSpeedSlider, { speedToVelocity } from './PtzSpeedSlider';
import SensorBar from './SensorBar';
import SensorPanel from './SensorPanel';

const ACCENT = colors.accent;
const ZOOM_STEP = 0.3;
const PTZ_PULSE_SEC = 0.2;
const PTZ_HOLD_MS = 180;
const PTZ_JOG_MS = 280;
const PTZ_SPEED_KEY = 'sentinel-ptz-speed';

const pad3 = (n: number) => String(((Math.round(n) % 360) + 360) % 360).padStart(3, '0');
const elFmt = (e: number) => (e >= 0 ? '+' : '-') + String(Math.abs(Math.round(e))).padStart(2, '0');

interface Props {
  deviceId: string;
  deviceLabel: string;
}

export default function DashboardConsole({ deviceId, deviceLabel }: Props) {
  const { client, session } = usePlatform();
  const [selectedCamId, setSelectedCamId] = useState('01');
  const {
    streams, status, connected, cameras, alerts, hlsUrls,
    recording, setRecordingLocal,
  } = useTowerLive(deviceId, selectedCamId);
  const sensors = useMemo(() => buildSensors(status, streams, cameras), [status, streams, cameras]);
  const ngrok = session.baseUrl.includes('ngrok');
  // Hub reachability (Platform API can talk to the tower via hub) — not sensor health.
  const linkColor = connected ? colors.accent : colors.offline;
  const linkLabel = connected ? 'Hub link live' : 'Hub link offline';

  const [now, setNow] = useState(() => Date.now());
  const [controlOpen, setControlOpen] = useState(true);
  const [spotlight, setSpotlight] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [ptzMsg, setPtzMsg] = useState('');
  const [recBusy, setRecBusy] = useState(false);
  const [ptzSpeedPct, setPtzSpeedPct] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(PTZ_SPEED_KEY));
      if (saved >= 5 && saved <= 100) return saved;
    } catch { /* */ }
    return 35;
  });

  const ptzVelocity = useMemo(() => speedToVelocity(ptzSpeedPct), [ptzSpeedPct]);
  const jogTimer = useRef<number | undefined>(undefined);
  const jogInterval = useRef<number | undefined>(undefined);
  const jogDir = useRef<PanDir | null>(null);
  const jogging = useRef(false);

  const selectedCam = cameras.find((c) => c.id === selectedCamId) ?? cameras[0];

  useEffect(() => {
    if (cameras.length && !cameras.some((c) => c.id === selectedCamId)) {
      setSelectedCamId(cameras[0].id);
    }
  }, [cameras, selectedCamId]);

  const camNum = useCallback((id: string) => parseInt(id, 10) || 1, []);

  const sendMove = useCallback((dir: PanDir | null, zoomDir: number, seconds: number) => {
    const cam = camNum(selectedCam?.id ?? '01');
    const p = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    const t = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
    return client.ptzMove(deviceId, {
      camera: cam,
      mode: 'continuous',
      pan: p * ptzVelocity,
      tilt: t * ptzVelocity,
      zoom: zoomDir * ptzVelocity,
      seconds,
    });
  }, [client, deviceId, selectedCam, camNum, ptzVelocity]);

  const stopJog = useCallback(() => {
    if (jogTimer.current !== undefined) { window.clearTimeout(jogTimer.current); jogTimer.current = undefined; }
    if (jogInterval.current !== undefined) { window.clearInterval(jogInterval.current); jogInterval.current = undefined; }
    if (jogging.current) {
      jogging.current = false;
      void client.ptzStop(deviceId, { camera: camNum(selectedCam?.id ?? '01') });
    }
    jogDir.current = null;
  }, [client, deviceId, selectedCam, camNum]);

  const nudge = useCallback((dir: PanDir) => {
    void sendMove(dir, 0, PTZ_PULSE_SEC).then(() => setPtzMsg('move ok')).catch((e: unknown) => setPtzMsg(`move failed: ${errMsg(e)}`));
  }, [sendMove]);

  const panStart = useCallback((dir: PanDir) => {
    stopJog();
    jogDir.current = dir;
    jogTimer.current = window.setTimeout(() => {
      jogTimer.current = undefined;
      jogging.current = true;
      void sendMove(dir, 0, PTZ_PULSE_SEC);
      jogInterval.current = window.setInterval(() => { void sendMove(dir, 0, PTZ_PULSE_SEC); }, PTZ_JOG_MS);
    }, PTZ_HOLD_MS);
  }, [stopJog, sendMove]);

  const panEnd = useCallback(() => {
    if (jogTimer.current !== undefined) {
      window.clearTimeout(jogTimer.current);
      jogTimer.current = undefined;
      if (jogDir.current) nudge(jogDir.current);
      jogDir.current = null;
      return;
    }
    stopJog();
  }, [nudge, stopJog]);

  const zoomBy = useCallback((d: number) => {
    const dir = d > 0 ? 1 : -1;
    void sendMove(null, dir, PTZ_PULSE_SEC).then(() => setPtzMsg('zoom ok')).catch((e: unknown) => setPtzMsg(`zoom failed: ${errMsg(e)}`));
  }, [sendMove]);

  const captureSnapshot = useCallback(async (camId: string) => {
    try {
      const blob = await client.snapshot(deviceId, camNum(camId));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${deviceId}_cam${camNum(camId)}_${Date.now()}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
      return 'downloaded';
    } catch (e) {
      setPtzMsg(`snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, [client, deviceId, camNum]);

  const toggleRecording = useCallback(async () => {
    if (recBusy) return;
    const next = !(recording?.enabled);
    setRecBusy(true);
    setPtzMsg(next ? 'enabling recording…' : 'stopping recording…');
    try {
      const res = await client.setRecording(deviceId, next);
      setRecordingLocal(res);
      if (res.error) {
        setPtzMsg(`recording failed: ${res.error.message ?? res.error.code ?? 'error'}`);
      } else if (res.persist_ok === false) {
        setPtzMsg(`recording ${next ? 'ON' : 'OFF'} (live) — persist warning`);
      } else {
        setPtzMsg(`recording ${next ? 'ON' : 'OFF'}`);
      }
      if (res.warnings?.length) {
        console.warn('recording warnings', res.warnings);
      }
    } catch (e) {
      setPtzMsg(`recording failed: ${errMsg(e)}`);
    } finally {
      setRecBusy(false);
    }
  }, [client, deviceId, recBusy, recording?.enabled, setRecordingLocal]);

  const recenter = useCallback(() => {
    void client.ptzStop(deviceId, { camera: camNum(selectedCam?.id ?? '01'), home: true })
      .then(() => setPtzMsg('home ok'))
      .catch((e: unknown) => setPtzMsg(`home failed: ${errMsg(e)}`));
  }, [client, deviceId, selectedCam, camNum]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => () => stopJog(), [stopJog]);

  const utc = new Date(now).toISOString().slice(11, 19);

  return (
    <div className="app">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: font.display, fontWeight: 700, fontSize: 24, letterSpacing: '.24em', color: colors.textBright }}>SENTINEL</span>
          <span style={{ fontFamily: font.display, fontWeight: 500, fontSize: 14, letterSpacing: '.32em', color: colors.textFaint }}>TERRA</span>
          <span className="device-pill" title={linkLabel}>
            <span className="pill-hd" style={{ background: linkColor, color: linkColor }} />
            {deviceLabel}
          </span>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontFamily: font.mono, fontSize: 19, color: colors.textBright, letterSpacing: '.06em' }}>{utc}</div>
          <div style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: '.16em', color: colors.textFaint }}>UTC · PLATFORM API</div>
        </div>
      </header>

      <SensorBar sensors={sensors} deviceName={deviceLabel} connected={connected} onOpenDetail={() => setPanelOpen(true)} />

      <main className={`console${controlOpen ? '' : ' collapsed'}`}>
        <button className="panel-toggle" onClick={() => setControlOpen((v) => !v)} aria-expanded={controlOpen}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="15" y1="4" x2="15" y2="20" /></svg>
        </button>

        <section className={`grid${spotlight ? ' spotlight' : ''}`}>
          {!connected && cameras.every((c) => c.status === 'STANDBY') && (
            <div className="feed-loading" role="status">Tower unreachable via hub</div>
          )}
          {cameras.map((c) => (
            <TowerFeed
              key={c.id}
              camera={c}
              selected={c.id === selectedCam?.id}
              accent={ACCENT}
              spotlighted={spotlight && c.id === selectedCam?.id}
              thumb={spotlight && c.id !== selectedCam?.id}
              onSelect={() => setSelectedCamId(c.id)}
              onToggleSpotlight={() => setSpotlight((v) => !v)}
              onSnapshot={() => captureSnapshot(c.id)}
              hlsUrl={c.id === selectedCam?.id ? (hlsUrls[c.id] ?? c.hlsUrl) : undefined}
              apiKey={session.apiKey}
              ngrok={ngrok}
            />
          ))}
        </section>

        {selectedCam && (
          <aside className="control">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 12, paddingRight: 34, borderBottom: `1px solid ${colors.line}` }}>
              <div>
                <div style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: '.24em', color: colors.textFaint }}>CAMERA UNDER CONTROL</div>
                <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 20, letterSpacing: '.1em', color: ACCENT, marginTop: 3 }}>{selectedCam.label}</div>
              </div>
              <div style={{ fontFamily: font.mono, fontSize: 11, color: colors.text, letterSpacing: '.1em' }}>CAM {selectedCam.id}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Metric k="AZIMUTH" v={selectedCam.ptzLive ? `${pad3(selectedCam.az)}°` : '—'} />
              <Metric k="ELEVATION" v={selectedCam.ptzLive ? `${elFmt(selectedCam.el)}°` : '—'} />
              <Metric k="ZOOM" v={selectedCam.ptzLive ? formatZoom(selectedCam.zoom) : '—'} />
              <Metric k="STREAM" v={selectedCam.status === 'ONLINE' ? 'HLS LIVE' : selectedCam.status} />
            </div>
            <button
              className={`rec-btn${recording?.enabled ? ' rec-btn--on' : ''}`}
              disabled={recBusy || !connected}
              title={recording?.enabled ? 'Stop continuous recording' : 'Start continuous recording'}
              onClick={() => void toggleRecording()}
            >
              <span
                className={recording?.enabled ? 'rec-dot' : undefined}
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: recording?.enabled ? colors.offline : colors.textFaint,
                }}
              />
              {recBusy
                ? 'RECORDING…'
                : recording?.enabled
                  ? 'RECORDING · ON'
                  : 'RECORDING · OFF'}
            </button>
            <div style={{ minHeight: 14, fontFamily: font.mono, fontSize: 10, color: ptzMsg.includes('failed') ? colors.offline : colors.textFaint }}>{ptzMsg}</div>
            <PtzSpeedSlider value={ptzSpeedPct} onChange={(pct) => { setPtzSpeedPct(pct); try { localStorage.setItem(PTZ_SPEED_KEY, String(pct)); } catch { /* */ } }} accent={ACCENT} />
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <PtzPad accent={ACCENT} onPanStart={panStart} onPanEnd={panEnd} onRecenter={recenter} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="ctl-btn" onClick={() => zoomBy(-ZOOM_STEP)}>− ZOOM</button>
              <button className="ctl-btn" onClick={() => zoomBy(ZOOM_STEP)}>ZOOM +</button>
            </div>
          </aside>
        )}
      </main>

      <SensorPanel open={panelOpen} deviceName={deviceLabel} sensors={sensors} alerts={alerts} connected={connected} onClose={() => setPanelOpen(false)} />
    </div>
  );
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ background: colors.bgWell, border: `1px solid ${colors.line}`, borderRadius: 6, padding: '8px 10px' }}>
      <div style={{ fontFamily: font.mono, fontSize: 9, letterSpacing: '.18em', color: colors.textFaint }}>{k}</div>
      <div style={{ fontFamily: font.mono, fontSize: 17, color: colors.textBright, marginTop: 2 }}>{v}</div>
    </div>
  );
}