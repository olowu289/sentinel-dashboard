import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StreamsResponse, RecordingStatus } from '@sentinel/sdk';
import type { StatusResponse } from '../apiTypes';
import type { Camera } from '../types';
import { colors, font } from '../tokens';
import { formatClockUTC1 } from '../clock';
import { errCode, formatApiError, linkStatusLabel } from '../util';
import { buildSensors } from '../sensors';
import { usePlatform } from '../platformContext';
import { formatAzimuth, formatElevation, formatZoom, NO_DATA } from '../ptzMetrics';
import { ptzKeepalive } from '../ptzApi';
import type { RailView } from './Rail';
import TowerFeed from './TowerFeed';
import AiAlignedTile from './AiAlignedTile';
import PtzPad, { type PanDir } from './PtzPad';
import PtzSpeedSlider, { speedToVelocity } from './PtzSpeedSlider';
import SensorBar from './SensorBar';
import { loadVideoSourceMode, saveVideoSourceMode, localWhepUrl, type VideoSourceMode } from '../videoSourceMode';
import { localPtzMove, localPtzStop, localPtzStatus, localPtzKeepalive } from '../localPtzApi';
import { subscribeAiTracking, setAiTrackingArmed } from '../aiTrackingState';
import type { AiTrackingState } from '../aiTrackingApi';

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
// Position poll over the LAN. Fast on purpose: this is a direct hop to the
// tower, and the daemon caches the camera's own reading for 0.4s, so this
// cadence tracks the camera while it turns without hammering it. The
// platform path polls at 3s and cannot do this - hence preferring the cable.
const LOCAL_PTZ_POLL_MS = 600;

/** True for "superseded" — the daemon's normal, by-design outcome when a
 * newer PTZ command already replaced this one (rapid taps/direction
 * changes on the pad — see kallon_ptz_daemon.py's CameraQueue). Not a
 * failure: distinct from a real tower_error, never shown in red. */
function isSupersededError(e: unknown): boolean {
  return errCode(e) === 'superseded';
}

/** Axis names the daemon had to clamp into the camera's real ONVIF range
 * (pan/tilt -1..1, zoom 0..1/-1..1 — see kallon_ptz_daemon.py's
 * PAN_TILT_RANGE/ZOOM_ABS_RANGE/ZOOM_VEL_RANGE) rather than sending the
 * out-of-range value through and letting ONVIF fault. Empty when the move
 * landed on its own, well inside range. */
function ptzClampedAxes(res: unknown): string[] {
  const result = (res as { result?: { clamped?: boolean; clamped_axes?: { axis: string }[] } } | null | undefined)
    ?.result;
  if (!result?.clamped) return [];
  return (result.clamped_axes ?? []).map((a) => a.axis);
}


/** One position reading. Every field is nullable on purpose: the tower
 * omits what the camera did not report, and a dash on screen is the honest
 * rendering of "not known". */
interface PtzReadout {
  az: number | null;
  el: number | null;
  zoom: number | null;
  moving: boolean;
  live: boolean;
}

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
  const [aiTracking, setAiTracking] = useState<AiTrackingState>({ armed: false, engine_connected: false, tracking_capable: false });
  const [aiTrackingBusy, setAiTrackingBusy] = useState(false);
  /** Instant visual feedback on click, independent of the network round-trip
   * (aiTrackingBusy's "…" only reads as feedback once a request is already
   * in flight - this fires synchronously on pointerdown-equivalent so a
   * click never LOOKS like it did nothing during that gap). Cleared on a
   * short timeout, not tied to the request's own resolution. */
  const [aiTrackingClickPulse, setAiTrackingClickPulse] = useState(false);
  useEffect(() => subscribeAiTracking((s) => {
    // eslint-disable-next-line no-console
    console.log('[ai-tracking] poll update', s, 'button would be disabled:', !s.armed && (!s.tracking_capable || !s.engine_connected));
    setAiTracking(s);
  }), []);
  const toggleAiTracking = useCallback(async () => {
    setAiTrackingClickPulse(true);
    window.setTimeout(() => setAiTrackingClickPulse(false), 350);
    // eslint-disable-next-line no-console
    console.log('[ai-tracking] toggleAiTracking() called', {
      aiTrackingBusy, armed: aiTracking.armed, engine_connected: aiTracking.engine_connected,
      tracking_capable: aiTracking.tracking_capable,
    });
    if (aiTrackingBusy) {
      // eslint-disable-next-line no-console
      console.log('[ai-tracking] early return: aiTrackingBusy is true');
      return;
    }
    setAiTrackingBusy(true);
    try {
      // eslint-disable-next-line no-console
      console.log('[ai-tracking] calling setAiTrackingArmed', !aiTracking.armed);
      await setAiTrackingArmed(!aiTracking.armed);
      // eslint-disable-next-line no-console
      console.log('[ai-tracking] setAiTrackingArmed resolved');
      setPtzMsg(aiTracking.armed ? 'AI tracking disarmed' : 'AI tracking ARMED');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[ai-tracking] setAiTrackingArmed threw', e);
      setPtzMsg(`AI tracking failed: ${formatApiError(e)}`);
    } finally {
      setAiTrackingBusy(false);
    }
  }, [aiTracking.armed, aiTrackingBusy]);
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
      .then((res) => {
        const axes = ptzClampedAxes(res);
        setPtzMsg(axes.length ? `${axes.join('/')} at limit` : `ptz ${dir}`);
      })
      .catch((e: unknown) => setPtzMsg(isSupersededError(e) ? `ptz ${dir} (busy)` : `move failed: ${formatApiError(e)}`));
    jogTimer.current = window.setTimeout(() => {
      jogTimer.current = undefined;
      jogging.current = true;
      bumpLiveSync();
      setPtzMsg('jog…');
      // True continuous hold: exactly one unbounded start (no repeating
      // pulses — that was the stutter). A keepalive every PTZ_KEEPALIVE_MS
      // refreshes the daemon's 4s safety timeout for as long as this is
      // held; the actual stop is sent from panEnd/stopJog on release.
      void sendMove(dir, 0, ptzVelocity)
        .then((res) => {
          const axes = ptzClampedAxes(res);
          if (axes.length) setPtzMsg(`${axes.join('/')} at limit`);
        })
        .catch((e: unknown) => setPtzMsg(isSupersededError(e) ? `ptz ${dir} (busy)` : `move failed: ${formatApiError(e)}`));
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
      .then((res) => {
        const axes = ptzClampedAxes(res);
        setPtzMsg(axes.length ? 'zoom at limit' : dir > 0 ? 'zoom in' : 'zoom out');
      })
      .catch((e: unknown) => setPtzMsg(isSupersededError(e) ? 'zoom (busy)' : `zoom failed: ${formatApiError(e)}`));
    zoomJogTimer.current = window.setTimeout(() => {
      zoomJogTimer.current = undefined;
      zoomJogging.current = true;
      bumpLiveSync();
      setPtzMsg('zoom…');
      void sendMove(null, dir, ZOOM_HOLD_VELOCITY)
        .then((res) => {
          if (ptzClampedAxes(res).length) setPtzMsg('zoom at limit');
        })
        .catch((e: unknown) => setPtzMsg(isSupersededError(e) ? 'zoom (busy)' : `zoom failed: ${formatApiError(e)}`));
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
      .catch((e: unknown) => setPtzMsg(isSupersededError(e) ? 'home (busy)' : `home failed: ${formatApiError(e)}`));
  }, [client, deviceId, selectedCam, camNum, bumpLiveSync, isLocalVideo]);

  // Local mode's own PTZ status poll — separate from useTowerLive's
  // platform-path poll (which keeps running harmlessly in the background;
  // it's a shared hook used by other views too, not worth threading this
  // mode through). Same cadence as useTowerLive's PTZ_MS. Only overrides
  // the READOUT below; cameras/az/el/zoom from useTowerLive are untouched.
  // POSITION READOUT — polled straight down the cable to the tower's own
  // gateway, not round-tripped through the platform.
  //
  // Two reasons, and neither is only about speed. The LAN path is a direct
  // hop to the machine that already has the answer, so it can be polled fast
  // enough for the number to track the camera while it turns — the platform
  // path is a 3s poll through Railway, which shows where the camera USED to
  // be. And it stays truthful under failure: if the cable is unreachable the
  // readout goes blank rather than quietly aging.
  //
  // Runs regardless of which video source is selected — where the pixels come
  // from has nothing to do with where the position is read from.
  const [localPtz, setLocalPtz] = useState<PtzReadout | null>(null);
  useEffect(() => {
    if (!selectedCam) { setLocalPtz(null); return; }
    let cancelled = false;
    const cam = camNum(selectedCam.id);
    const poll = async () => {
      try {
        const r = await localPtzStatus(cam);
        const res = (r.result ?? {}) as NonNullable<typeof r.result> & { moving?: boolean };
        // As reported, or not at all. The tower omits these when the camera
        // did not answer; anything invented here would be indistinguishable
        // from a real reading on screen.
        const az = res.pan_deg ?? null;
        const el = res.tilt_deg ?? null;
        const zoom = res.zoom_ratio ?? null;
        if (!cancelled) {
          setLocalPtz(
            az == null && el == null && zoom == null
              ? null
              : { az, el, zoom, moving: res.moving === true, live: true },
          );
        }
      } catch {
        // Not on the island, or the gateway is down. Blank, never stale.
        if (!cancelled) setLocalPtz(null);
      }
    };
    void poll();
    const id = window.setInterval(poll, LOCAL_PTZ_POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [selectedCam, camNum]);

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

  // The cable reading wins when we have one; the platform poll is the
  // fallback for operating off-site. Neither path fabricates: if both are
  // empty this stays null and every field renders as a dash.
  const ptzReadout: PtzReadout | null =
    localPtz
    ?? (selectedCam && selectedCam.ptzLive
      ? {
          az: selectedCam.az, el: selectedCam.el, zoom: selectedCam.zoom,
          moving: selectedCam.ptzMoving === true, live: true,
        }
      : null);
  const ptzSource = localPtz ? 'cable' : (ptzReadout ? 'platform' : null);

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
            c.path === 'cam3' ? (
              <AiAlignedTile
                key={c.id}
                streamName="kallon_cam1_main"
                cameraLabel="cam1"
                spotlightThumb={spotlight}
              />
            ) : (
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
                syncLiveTick={c.id === selectedCam?.id ? ptzLiveSyncTick : undefined}
                apiKey={isLocalVideo ? '' : session.apiKey}
                ngrok={ngrok}
                localMode={isLocalVideo}
              />
            )
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
              <Readout k="AZIMUTH" v={formatAzimuth(ptzReadout?.az)} />
              <Readout k="ELEVATION" v={formatElevation(ptzReadout?.el)} />
              <Readout k="ZOOM" v={formatZoom(ptzReadout?.zoom)} />
              <Readout k="STREAM" v={selectedCam.status === 'ONLINE' ? 'LIVE' : selectedCam.status} accent={selectedCam.status === 'ONLINE'} />
            </div>

            <div
              style={{
                fontFamily: font.mono, fontSize: 10, letterSpacing: '0.06em',
                color: ptzSource ? colors.textCaption : colors.offline,
                display: 'flex', gap: 6, alignItems: 'center',
              }}
              title={
                ptzSource === 'cable' ? 'Position read directly from the tower over the LAN'
                : ptzSource === 'platform' ? 'Position via the platform — slower, and only as fresh as its 3s poll'
                : 'No position link — the values above are unavailable, not zero'
              }
            >
              <span>POSITION</span>
              <span style={{ color: ptzSource === 'cable' ? ACCENT : undefined }}>
                {ptzSource === 'cable' ? 'CABLE' : ptzSource === 'platform' ? 'PLATFORM' : NO_DATA}
              </span>
              {ptzReadout?.moving && <span style={{ color: ACCENT }}>· SLEWING</span>}
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

            <button
              type="button"
              className={`rec-row ai-track-row${aiTracking.armed ? ' armed' : ''}${aiTrackingClickPulse ? ' click-pulse' : ''}`}
              disabled={aiTrackingBusy || (!aiTracking.armed && (!aiTracking.tracking_capable || !aiTracking.engine_connected))}
              title={
                !aiTracking.tracking_capable ? 'This tower is not provisioned for AI tracking'
                : !aiTracking.armed && !aiTracking.engine_connected ? 'Detection engine not connected — cannot arm'
                : aiTracking.armed ? 'Disarm autonomous AI tracking' : 'Arm autonomous AI tracking'
              }
              onClick={() => void toggleAiTracking()}
            >
              <span className="rec-row-left">
                <span className="rec-row-dot" />
                AI TRACKING
              </span>
              <span className="rec-row-state">
                {aiTrackingBusy ? '…' : aiTracking.armed ? 'ARMED' : 'OFF'}
              </span>
            </button>
            <div style={{ marginTop: -4, marginBottom: 2, fontFamily: font.mono, fontSize: 9, color: colors.textCaption }}>
              autonomous camera-follow — not the tile's "AI" overlay button
            </div>
            {!aiTracking.armed && aiTracking.tracking_capable && !aiTracking.engine_connected && (
              <div style={{ marginTop: -6, fontFamily: font.mono, fontSize: 9, color: colors.textCaption }}>
                detection engine not connected
              </div>
            )}

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
