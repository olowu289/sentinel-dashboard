import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StreamsResponse, RecordingStatus } from '@sentinel/sdk';
import type { StatusResponse } from '../apiTypes';
import type { Camera } from '../types';
import { colors, font } from '../tokens';
import { formatClockUTC1 } from '../clock';
import { formatApiError, linkStatusLabel } from '../util';
import { buildSensors } from '../sensors';
import { usePlatform } from '../platformContext';
import { formatZoom } from '../ptzMetrics';
import { ptzKeepalive } from '../ptzApi';
import type { RailView } from './Rail';
import TowerFeed from './TowerFeed';
import PtzPad, { type PanDir } from './PtzPad';
import PtzSpeedSlider, { speedToVelocity } from './PtzSpeedSlider';
import SensorBar from './SensorBar';
import AiDetectionView from './AiDetectionView';
import { loadVideoSourceMode, saveVideoSourceMode, localWhepUrl, type VideoSourceMode } from '../videoSourceMode';
import { localPtzMove, localPtzStop, localPtzStatus, localPtzKeepalive } from '../localPtzApi';

const ACCENT = colors.accent;
const PTZ_PULSE_SEC = 0.2;
const PTZ_HOLD_MS = 180;
const PTZ_SPEED_KEY = 'sentinel-ptz-speed';
/** Hold-to-move keepalive cadence — well under the daemon's 4s safety
 * timeout (kallon_ptz_daemon.py), so a normal 2s tick never risks a
 * mid-hold auto-stop even with some network jitter. */
const PTZ_KEEPALIVE_MS = 2000;
/** Zoom-hold velocity, decoupled from the drive-speed slider (that's for
 * fine pan/tilt jogging) — fast and purposeful, per design. Zoom taps keep
 * using the slider-scaled velocity below (their existing fine nudge). */
const ZOOM_HOLD_VELOCITY = 0.8;
/** Local-mode PTZ status poll cadence — matches useTowerLive's own PTZ_MS. */
const LOCAL_PTZ_POLL_MS = 3000;

const pad3 = (n: number) => String(((Math.round(n) % 360) + 360) % 360).padStart(3, '0');
const elFmt = (e: number) => (e >= 0 ? '+' : '-') + String(Math.abs(Math.round(e))).padStart(2, '0');

interface Props {
  deviceId: string;
  deviceLabel: string;
  view: RailView;
  onSelectView: (v: RailView) => void;
  onOpenTowerMenu: () => void;
  /** Which camera tile is under PTZ control — owned by FleetApp (shared
   * with the useTowerLive instance's PTZ poll), not local state here. */
  selectedCamId: string;
  onSelectCamId: (id: string) => void;
  streams: StreamsResponse | null;
  status: StatusResponse | null;
  connected: boolean;
  linkError: string;
  cameras: Camera[];
  hlsUrls: Record<string, string>;
  webrtcUrls: Record<string, string>;
  recording: RecordingStatus | null;
  setRecordingLocal: (s: RecordingStatus | null) => void;
}

export default function DashboardConsole({
  deviceId, deviceLabel, view, onSelectView, onOpenTowerMenu,
  selectedCamId, onSelectCamId, streams, status, connected, linkError, cameras,
  hlsUrls, webrtcUrls, recording, setRecordingLocal,
}: Props) {
  const { client, session, logout } = usePlatform();
  const [aiView, setAiView] = useState<{ streamName: string; cameraLabel: string } | null>(null);
  const sensors = useMemo(() => buildSensors(status, streams, cameras), [status, streams, cameras]);
  const ngrok = session.baseUrl.includes('ngrok');
  // Hub reachability (Platform API can talk to the tower via hub) — not sensor health.
  const linkColor = connected ? colors.online : colors.offline;
  const linkLabel = linkStatusLabel(connected, linkError);

  const [now, setNow] = useState(() => Date.now());
  const [videoMode, setVideoMode] = useState<VideoSourceMode>(loadVideoSourceMode);
  const isLocalVideo = videoMode === 'local';
  const toggleVideoMode = useCallback(() => {
    setVideoMode((m) => {
      const next: VideoSourceMode = m === 'platform' ? 'local' : 'platform';
      saveVideoSourceMode(next);
      return next;
    });
  }, []);
  const [controlOpen, setControlOpen] = useState(true);
  const [spotlight, setSpotlight] = useState(false);
  const [ptzMsg, setPtzMsg] = useState('');
  const [recBusy, setRecBusy] = useState(false);
  // No busy-disable lockout on the pad/zoom anymore — the daemon's supersede
  // queue (see ptz-polish.md) makes rapid taps safe server-side, so the UI
  // just shows a pressed/active state and never goes inert while a command
  // is in flight.
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
  // Zoom hold-to-jog — same pattern as the pan pad, independent state so pan
  // and zoom can never cross-cancel each other.
  const zoomJogTimer = useRef<number | undefined>(undefined);
  const zoomJogInterval = useRef<number | undefined>(undefined);
  const zoomJogDir = useRef<1 | -1 | null>(null);
  const zoomJogging = useRef(false);
  const [zoomActive, setZoomActive] = useState<1 | -1 | null>(null);
  const [ptzLiveSyncTick, setPtzLiveSyncTick] = useState(0);

  /** Snap selected feed to the true live edge on PTZ (not throttled — player debounces seeks). */
  const bumpLiveSync = useCallback(() => {
    setPtzLiveSyncTick((n) => n + 1);
  }, []);

  const selectedCam = cameras.find((c) => c.id === selectedCamId) ?? cameras[0];

  const camNum = useCallback((id: string) => parseInt(id, 10) || 1, []);

  /** seconds omitted = unbounded start (daemon runs it until a "stop"
   * arrives, or its own 4s safety timeout); a real value = the original
   * bounded pulse (one self-contained tap, no follow-up stop needed). */
  const sendMove = useCallback((dir: PanDir | null, zoomDir: number, zoomVelocity: number, seconds?: number) => {
    const cam = camNum(selectedCam?.id ?? '01');
    const p = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    const t = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
    const body = {
      camera: cam,
      mode: 'continuous' as const,
      pan: p * ptzVelocity,
      tilt: t * ptzVelocity,
      zoom: zoomDir * zoomVelocity,
      ...(seconds !== undefined ? { seconds } : {}),
    };
    // Local mode routes PTZ direct to the Jetson's gateway (same body shape
    // either way — the platform proxy just forwards this verbatim to the
    // tower's own /api/ptz/move). Never silently falls back to the platform
    // path on failure — see the .catch callers below.
    return isLocalVideo ? localPtzMove(body) : client.ptzMove(deviceId, body);
  }, [client, deviceId, selectedCam, camNum, ptzVelocity, isLocalVideo]);

  const stopJog = useCallback(() => {
    if (jogTimer.current !== undefined) { window.clearTimeout(jogTimer.current); jogTimer.current = undefined; }
    if (jogInterval.current !== undefined) { window.clearInterval(jogInterval.current); jogInterval.current = undefined; }
    if (jogging.current) {
      jogging.current = false;
      bumpLiveSync();
      const cam = camNum(selectedCam?.id ?? '01');
      void (isLocalVideo ? localPtzStop({ camera: cam }) : client.ptzStop(deviceId, { camera: cam }));
    }
    jogDir.current = null;
  }, [client, deviceId, selectedCam, camNum, bumpLiveSync, isLocalVideo]);

  const panStart = useCallback((dir: PanDir) => {
    stopJog();
    bumpLiveSync();
    setPtzMsg(`ptz ${dir}…`);
    jogDir.current = dir;
    // Fire immediately on press so the camera reacts without waiting for the
    // hold threshold or pointer-up — the pad's own pressed/active visual
    // (set by PtzPad itself on pointerdown) is the immediate feedback. This
    // tap pulse is unchanged: a small, self-contained bounded move — untouched
    // regardless of whether the press turns into a hold.
    void sendMove(dir, 0, ptzVelocity, PTZ_PULSE_SEC)
      .then(() => setPtzMsg(`ptz ${dir}`))
      .catch((e: unknown) => setPtzMsg(`move failed: ${formatApiError(e)}`));
    jogTimer.current = window.setTimeout(() => {
      jogTimer.current = undefined;
      jogging.current = true;
      bumpLiveSync();
      setPtzMsg('jog…');
      // True continuous hold: exactly one unbounded start (no repeating
      // pulses — that was the stutter). A keepalive every PTZ_KEEPALIVE_MS
      // refreshes the daemon's 4s safety timeout for as long as this is
      // held; the actual stop is sent from panEnd/stopJog on release.
      void sendMove(dir, 0, ptzVelocity).catch((e: unknown) => setPtzMsg(`move failed: ${formatApiError(e)}`));
      jogInterval.current = window.setInterval(() => {
        const cam = camNum(selectedCam?.id ?? '01');
        void (isLocalVideo ? localPtzKeepalive(cam) : ptzKeepalive(session, deviceId, cam)).catch(() => { /* best-effort */ });
      }, PTZ_KEEPALIVE_MS);
    }, PTZ_HOLD_MS);
  }, [stopJog, sendMove, bumpLiveSync, session, deviceId, selectedCam, camNum, isLocalVideo]);

  const panEnd = useCallback(() => {
    // Tap already sent a pulse on panStart; only clear hold-to-jog if still pending.
    if (jogTimer.current !== undefined) {
      window.clearTimeout(jogTimer.current);
      jogTimer.current = undefined;
      jogDir.current = null;
      return;
    }
    stopJog();
  }, [stopJog]);

  const stopZoomJog = useCallback(() => {
    if (zoomJogTimer.current !== undefined) { window.clearTimeout(zoomJogTimer.current); zoomJogTimer.current = undefined; }
    if (zoomJogInterval.current !== undefined) { window.clearInterval(zoomJogInterval.current); zoomJogInterval.current = undefined; }
    if (zoomJogging.current) {
      zoomJogging.current = false;
      bumpLiveSync();
      const cam = camNum(selectedCam?.id ?? '01');
      void (isLocalVideo ? localPtzStop({ camera: cam }) : client.ptzStop(deviceId, { camera: cam }));
    }
    zoomJogDir.current = null;
  }, [client, deviceId, selectedCam, camNum, bumpLiveSync, isLocalVideo]);

  /** Zoom+/Zoom- are hold controls: an immediate tap pulse on press (the
   * existing small, slider-scaled nudge — unchanged), and if held past
   * PTZ_HOLD_MS, exactly ONE unbounded continuous-move start at a fixed,
   * fast velocity (decoupled from the drive-speed slider — that's for fine
   * pan/tilt jogging, not zoom holds), kept alive every PTZ_KEEPALIVE_MS
   * until release sends the actual stop (zoomEnd/stopZoomJog). No repeating
   * pulses — that was the stutter this fixes. */
  const zoomStart = useCallback((dir: 1 | -1) => {
    stopZoomJog();
    bumpLiveSync();
    setPtzMsg(dir > 0 ? 'zoom in…' : 'zoom out…');
    zoomJogDir.current = dir;
    void sendMove(null, dir, ptzVelocity, PTZ_PULSE_SEC)
      .then(() => setPtzMsg(dir > 0 ? 'zoom in' : 'zoom out'))
      .catch((e: unknown) => setPtzMsg(`zoom failed: ${formatApiError(e)}`));
    zoomJogTimer.current = window.setTimeout(() => {
      zoomJogTimer.current = undefined;
      zoomJogging.current = true;
      bumpLiveSync();
      setPtzMsg('zoom…');
      void sendMove(null, dir, ZOOM_HOLD_VELOCITY).catch((e: unknown) => setPtzMsg(`zoom failed: ${formatApiError(e)}`));
      zoomJogInterval.current = window.setInterval(() => {
        const cam = camNum(selectedCam?.id ?? '01');
        void (isLocalVideo ? localPtzKeepalive(cam) : ptzKeepalive(session, deviceId, cam)).catch(() => { /* best-effort */ });
      }, PTZ_KEEPALIVE_MS);
    }, PTZ_HOLD_MS);
  }, [stopZoomJog, sendMove, bumpLiveSync, session, deviceId, selectedCam, camNum, isLocalVideo]);

  const zoomEnd = useCallback(() => {
    if (zoomJogTimer.current !== undefined) {
      window.clearTimeout(zoomJogTimer.current);
      zoomJogTimer.current = undefined;
      zoomJogDir.current = null;
      return;
    }
    stopZoomJog();
  }, [stopZoomJog]);

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
      setPtzMsg(`snapshot failed: ${formatApiError(e)}`);
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
        setPtzMsg(
          `recording ${next ? 'ON' : 'OFF'} live, but settings may not survive reboot`
          + (res.persist_error ? ` (${res.persist_error})` : ''),
        );
      } else {
        setPtzMsg(`recording ${next ? 'ON' : 'OFF'}`);
      }
      if (res.warnings?.length) {
        console.warn('recording warnings', res.warnings);
      }
    } catch (e) {
      setPtzMsg(`recording failed: ${formatApiError(e)}`);
    } finally {
      setRecBusy(false);
    }
  }, [client, deviceId, recBusy, recording?.enabled, setRecordingLocal]);

  const recenter = useCallback(() => {
    bumpLiveSync();
    const cam = camNum(selectedCam?.id ?? '01');
    const stop = isLocalVideo ? localPtzStop({ camera: cam, home: true }) : client.ptzStop(deviceId, { camera: cam, home: true });
    void stop
      .then(() => setPtzMsg('home ok'))
      .catch((e: unknown) => setPtzMsg(`home failed: ${formatApiError(e)}`));
  }, [client, deviceId, selectedCam, camNum, bumpLiveSync, isLocalVideo]);

  // Local mode's own PTZ status poll — separate from useTowerLive's
  // platform-path poll (which keeps running harmlessly in the background;
  // it's a shared hook used by other views too, not worth threading this
  // mode through). Same cadence as useTowerLive's PTZ_MS. Only overrides
  // the READOUT below; cameras/az/el/zoom from useTowerLive are untouched.
  const [localPtz, setLocalPtz] = useState<{ az: number; el: number; zoom: number; live: boolean } | null>(null);
  useEffect(() => {
    if (!isLocalVideo || !selectedCam) { setLocalPtz(null); return; }
    let cancelled = false;
    const cam = camNum(selectedCam.id);
    const poll = async () => {
      try {
        const r = await localPtzStatus(cam);
        const res = r.result ?? {};
        const panDeg = res.pan_deg ?? (res.pan != null ? res.pan * 180 : 0);
        const tiltDeg = res.tilt_deg ?? (res.tilt != null ? res.tilt * 45 : 0);
        const zoomRatio = res.zoom_ratio ?? (res.zoom != null ? 1 + res.zoom * 7 : 1);
        if (!cancelled) setLocalPtz({ az: panDeg, el: tiltDeg, zoom: zoomRatio, live: true });
      } catch {
        if (!cancelled) setLocalPtz(null); // camera not answering locally — readout shows "—", not stale data
      }
    };
    void poll();
    const id = window.setInterval(poll, LOCAL_PTZ_POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [isLocalVideo, selectedCam, camNum]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => () => { stopJog(); stopZoomJog(); }, [stopJog, stopZoomJog]);

  // Continuous holds are now unbounded on the daemon side (no per-pulse
  // auto-stop) — if the window loses focus mid-hold (alt-tab, tab switch)
  // no pointerup ever fires, so stop explicitly. The daemon's own 4s safety
  // timeout is the last-resort backstop (e.g. the tab/process dying outright).
  useEffect(() => {
    const onBlur = () => { stopJog(); stopZoomJog(); };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [stopJog, stopZoomJog]);

  // Local mode's own poll overrides the readout display only — cameras/
  // useTowerLive state is untouched (see the localPtz effect above).
  const ptzReadout = isLocalVideo
    ? (localPtz ?? { az: 0, el: 0, zoom: 0, live: false })
    : { az: selectedCam?.az ?? 0, el: selectedCam?.el ?? 0, zoom: selectedCam?.zoom ?? 0, live: !!selectedCam?.ptzLive };

  const utc = formatClockUTC1(now);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand-group">
          <span className="wordmark">SENTINEL</span>
          <span className="wordmark-sub">{session.customerId}</span>
        </div>

        <button type="button" className="tower-pill" onClick={onOpenTowerMenu} title={linkLabel}>
          <span className={`tower-pill-dot${connected ? ' live' : ''}`} style={{ background: linkColor, color: linkColor }} />
          <span className="tower-pill-label">{deviceLabel}</span>
          <span className="tower-pill-caret">▾</span>
        </button>

        <nav className="seg-tabs" aria-label="Main sections">
          <button type="button" className={view === 'live' ? 'active' : ''} onClick={() => onSelectView('live')}>Live wall</button>
          <button type="button" className={view === 'recordings' ? 'active' : ''} onClick={() => onSelectView('recordings')}>Recordings</button>
        </nav>

        <div className="topbar-end-group">
          <button
            type="button"
            className={`video-mode-toggle${isLocalVideo ? ' is-local' : ''}`}
            onClick={toggleVideoMode}
            title={
              isLocalVideo
                ? 'Video streaming direct from the tower over the local network — click to switch back to the platform path'
                : 'Video streaming via the platform/hub — click to switch to direct local-network video (requires being on the camera segment)'
            }
          >
            <span className="video-mode-dot" />
            {isLocalVideo ? 'LOCAL VIDEO' : 'PLATFORM VIDEO'}
          </button>
          <div className="topbar-divider" />
          <div className="topbar-clock">
            <div className="topbar-clock-time">{utc}</div>
            <div className="topbar-clock-sub">UTC+1 · {isLocalVideo ? 'LOCAL VIDEO' : 'PLATFORM API'}</div>
          </div>
          <div className="topbar-divider" />
          <button type="button" className="logout-btn" onClick={logout}>Sign out</button>
        </div>
      </header>

      <SensorBar
        sensors={sensors}
        deviceName={deviceLabel}
        connected={connected}
        linkError={linkError}
        onOpenDetail={() => onSelectView('sensors')}
      />

      <main className={`console${controlOpen ? '' : ' collapsed'}`}>
        <button className="panel-toggle" onClick={() => setControlOpen((v) => !v)} aria-expanded={controlOpen}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="15" y1="4" x2="15" y2="20" /></svg>
        </button>

        <section className={`grid${spotlight ? ' spotlight' : ''}`}>
          {!connected && cameras.every((c) => c.status === 'STANDBY') && (
            <div className="feed-loading" role="status">{linkLabel}</div>
          )}
          {cameras.map((c) => (
            <TowerFeed
              key={c.id}
              camera={c}
              selected={c.id === selectedCam?.id}
              accent={ACCENT}
              spotlighted={spotlight && c.id === selectedCam?.id}
              thumb={spotlight && c.id !== selectedCam?.id}
              onSelect={() => onSelectCamId(c.id)}
              onToggleSpotlight={() => setSpotlight((v) => !v)}
              onSnapshot={() => captureSnapshot(c.id)}
              hlsUrl={isLocalVideo ? undefined : (c.status === 'ONLINE' ? (hlsUrls[c.id] ?? c.hlsUrl) : undefined)}
              whepUrl={
                isLocalVideo
                  ? localWhepUrl(c.path)
                  : (c.status === 'ONLINE' ? (webrtcUrls[c.id] ?? c.webrtcUrl) : undefined)
              }
              onOpenAiView={(streamName) => setAiView({ streamName, cameraLabel: c.label })}
              syncLiveTick={c.id === selectedCam?.id ? ptzLiveSyncTick : undefined}
              apiKey={isLocalVideo ? '' : session.apiKey}
              ngrok={ngrok}
              localMode={isLocalVideo}
            />
          ))}
        </section>

        {selectedCam && (
          <aside className="control">
            <div className="control-head">
              <div>
                <div className="control-cap">CAMERA UNDER CONTROL</div>
                <div className="control-title">{selectedCam.label}</div>
              </div>
              <button
                type="button"
                className="control-expand"
                onClick={() => setSpotlight((v) => !v)}
                aria-pressed={spotlight}
                title={spotlight ? 'Exit fullscreen' : 'Fullscreen this feed'}
                aria-label={spotlight ? 'Exit fullscreen' : 'Fullscreen this feed'}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              </button>
            </div>

            <div className="readout-grid">
              <Readout k="AZIMUTH" v={ptzReadout.live ? `${pad3(ptzReadout.az)}°` : '—'} />
              <Readout k="ELEVATION" v={ptzReadout.live ? `${elFmt(ptzReadout.el)}°` : '—'} />
              <Readout k="ZOOM" v={ptzReadout.live ? formatZoom(ptzReadout.zoom) : '—'} />
              <Readout k="STREAM" v={selectedCam.status === 'ONLINE' ? 'LIVE' : selectedCam.status} accent={selectedCam.status === 'ONLINE'} />
            </div>

            <button
              type="button"
              className={`rec-row${recording?.enabled ? ' armed' : ''}`}
              disabled={recBusy || !connected}
              title={recording?.enabled ? 'Stop continuous recording' : 'Start continuous recording'}
              onClick={() => void toggleRecording()}
            >
              <span className="rec-row-left">
                <span className="rec-row-dot" />
                Recording
              </span>
              <span className="rec-row-state">
                {recBusy ? '…' : recording?.enabled ? 'ARMED' : 'OFF'}
              </span>
            </button>

            <div style={{ minHeight: 14, fontFamily: font.mono, fontSize: 10, color: ptzMsg.includes('failed') ? colors.offline : colors.textCaption }}>{ptzMsg}</div>
            <PtzSpeedSlider value={ptzSpeedPct} onChange={(pct) => { setPtzSpeedPct(pct); try { localStorage.setItem(PTZ_SPEED_KEY, String(pct)); } catch { /* */ } }} accent={ACCENT} />
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <PtzPad accent={ACCENT} size="190px" onPanStart={panStart} onPanEnd={panEnd} onRecenter={recenter} />
            </div>
            <div className="zoom-grid">
              <button
                type="button"
                className={`zoom-btn${zoomActive === -1 ? ' active' : ''}`}
                style={{ '--accent': ACCENT } as CSSProperties}
                onPointerDown={(e) => {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  setZoomActive(-1);
                  zoomStart(-1);
                }}
                onPointerUp={(e) => { e.preventDefault(); setZoomActive(null); zoomEnd(); }}
                onPointerCancel={() => { setZoomActive(null); zoomEnd(); }}
                onLostPointerCapture={() => { setZoomActive(null); zoomEnd(); }}
              >
                ZOOM −
              </button>
              <button
                type="button"
                className={`zoom-btn${zoomActive === 1 ? ' active' : ''}`}
                style={{ '--accent': ACCENT } as CSSProperties}
                onPointerDown={(e) => {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  setZoomActive(1);
                  zoomStart(1);
                }}
                onPointerUp={(e) => { e.preventDefault(); setZoomActive(null); zoomEnd(); }}
                onPointerCancel={() => { setZoomActive(null); zoomEnd(); }}
                onLostPointerCapture={() => { setZoomActive(null); zoomEnd(); }}
              >
                ZOOM +
              </button>
            </div>
          </aside>
        )}
      </main>

      {aiView && (
        <AiDetectionView
          key={aiView.streamName}
          streamName={aiView.streamName}
          cameraLabel={aiView.cameraLabel}
          onClose={() => setAiView(null)}
        />
      )}
    </div>
  );
}

function Readout({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="readout">
      <div className="readout-k">{k}</div>
      <div className="readout-v" style={accent ? { color: colors.online } : undefined}>{v}</div>
    </div>
  );
}
