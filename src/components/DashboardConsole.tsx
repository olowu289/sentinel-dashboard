import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { StreamsResponse, RecordingStatus } from '@sentinel/sdk';
import type { StatusResponse } from '../apiTypes';
import type { Camera } from '../types';
import { colors, font } from '../tokens';
import { formatClockUTC1 } from '../clock';
import { errCode, formatApiError, linkStatusLabel } from '../util';
import { buildSensors } from '../sensors';
import { formatAzimuth, formatElevation, formatZoom } from '../ptzMetrics';
import type { RailView } from './Rail';
import TowerFeed from './TowerFeed';
import { useTower } from '../towerContext';
import PtzAttitude from './PtzAttitude';
import AiAlignedTile from './AiAlignedTile';
import PtzPad, { PAN_VECTOR, type PanDir } from './PtzPad';
import TrackLog from './TrackLog';
import PtzSpeedSlider, { speedToVelocity } from './PtzSpeedSlider';
import SensorBar from './SensorBar';
import { localWhepUrl } from '../videoSourceMode';
import { localPtzMove, localPtzStop, localPtzStatus, localPtzKeepalive } from '../localPtzApi';
import { subscribeAiTracking, setAiTrackingArmed } from '../aiTrackingState';
import type { AiTrackingState } from '../aiTrackingApi';
import type { TrackEvent } from '../trackLog';
import Wordmark from './Wordmark';

const ACCENT = colors.accent;
/**
 * MINIMUM PRESS. A press sends one unbounded move on pointerdown and one stop
 * on pointerup — but an ONVIF move costs ~1.4s to reach the camera and a stop
 * ~0.56s, so a 60ms tap would otherwise queue its stop behind a move that has
 * not been dispatched yet and produce nothing visible. Holding the stop back
 * to this floor guarantees a tap still travels.
 *
 * It is a workaround for the transport being slow, not a design preference —
 * once jog moves off ONVIF (measured at 45-90ms on the camera's own CGI) this
 * can drop to near zero.
 */
const PTZ_MIN_PRESS_MS = 260;
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
  /** Which camera tile is under PTZ control — owned by FleetApp (shared
   * with the useTowerLive instance's PTZ poll), not local state here. */
  selectedCamId: string;
  onSelectCamId: (id: string) => void;
  streams: StreamsResponse | null;
  status: StatusResponse | null;
  connected: boolean;
  linkError: string;
  cameras: Camera[];
  /** Tower-wide track log — every camera's events in one list, so the operator
   *  never has to pick a camera to see what the tower is doing. */
  trackEvents: TrackEvent[];
  trackConnected: boolean;
  recording: RecordingStatus | null;
  setRecordingLocal: (s: RecordingStatus | null) => void;
  /**
   * Whether the live wall is the view on screen.
   *
   * The console stays MOUNTED when it is not — it hides itself instead. It
   * used to be unmounted by TowerApp, which destroyed every video element on
   * the way out and rebuilt them on the way back: new connections, a fresh
   * handshake, first frame from cold, and every per-tile DETECT toggle reset.
   * That is the "it reloads every time I come back" behaviour.
   *
   * Hidden here rather than by a wrapper in TowerApp because `.fleet-main >
   * .app` is a direct-child selector — a wrapper would stop it matching and
   * silently break the layout, and `display:contents` does not help since it
   * changes the box tree, not selector matching.
   */
  active?: boolean;
}

export default function DashboardConsole({
  deviceId, deviceLabel, view, onSelectView,
  selectedCamId, onSelectCamId, streams, status, connected, linkError, cameras,
  trackEvents, trackConnected, recording, setRecordingLocal, active = true,
}: Props) {
  const { client } = useTower();
  const sensors = useMemo(() => buildSensors(status, streams, cameras), [status, streams, cameras]);
  // Hub reachability (Platform API can talk to the tower via hub) — not sensor health.
  const linkColor = connected ? colors.online : colors.offline;
  const linkLabel = linkStatusLabel(connected, linkError);

  const [now, setNow] = useState(() => Date.now());
  // No mode to be in. The toggle that chose between the platform and the
  // cable went with the platform - a one-position switch would only raise
  // the question of what the other position did.
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
  /** When the current press began — the stop is held back to PTZ_MIN_PRESS_MS. */
  const pressAt = useRef(0);
  const zoomPressAt = useRef(0);
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

  // PTZ addresses a DOME, not a tile. Each dome shows two tiles (its PTZ
  // optic and its fixed one) and only the PTZ optic moves — so a command is
  // resolved through the tile's `unit`, never parsed out of its id. The fixed
  // tiles carry ids like "01F", which parseInt would silently accept.
  const camNum = useCallback(
    (id: string) => cameras.find((c) => c.id === id)?.unit ?? (parseInt(id, 10) || 1),
    [cameras],
  );

  /** seconds omitted = unbounded start (daemon runs it until a "stop"
   * arrives, or its own 4s safety timeout); a real value = the original
   * bounded pulse (one self-contained tap, no follow-up stop needed). */
  const sendMove = useCallback((dir: PanDir | null, zoomDir: number, zoomVelocity: number, seconds?: number) => {
    const cam = camNum(selectedCam?.id ?? '01');
    // Eight directions, from one table in PtzPad. The old inline ternaries
    // could only express the four cardinals, and a diagonal would have had to
    // be bolted on in two places that could drift apart.
    const v = dir ? PAN_VECTOR[dir] : { pan: 0, tilt: 0 };
    const p = v.pan;
    const t = v.tilt;
    const body = {
      camera: cam,
      // "jog" is the same command with a faster transport: the daemon drives
      // it over the camera's own CGI (~63ms to start, ~73ms to stop) instead
      // of ONVIF (~1348ms / ~564ms), falling back to ONVIF by itself on any
      // camera that does not speak it. A bounded pulse still goes out as
      // "continuous" — jog is unbounded by definition.
      mode: seconds === undefined ? ('jog' as const) : ('continuous' as const),
      pan: p * ptzVelocity,
      tilt: t * ptzVelocity,
      zoom: zoomDir * zoomVelocity,
      ...(seconds !== undefined ? { seconds } : {}),
    };
    // Local mode routes PTZ direct to the Jetson's gateway (same body shape
    // either way — the platform proxy just forwards this verbatim to the
    // tower's own /api/ptz/move). Never silently falls back to the platform
    // path on failure — see the .catch callers below.
    return localPtzMove(body);
  }, [selectedCam, camNum, ptzVelocity]);

  /** Cancels the keepalive and any pending delayed stop WITHOUT commanding
   * the camera. Starting a new move does not need a stop first: a
   * ContinuousMove replaces the velocity in flight (verified — reversing
   * +0.10 to -0.10 mid-move turned the camera around promptly). Sending one
   * anyway cost 0.56s and raced the move it preceded, because the two go out
   * as separate concurrent requests and the daemon's stop cancels whatever is
   * queued — including a move that arrived a few ms earlier. */
  const clearJogTimers = useCallback(() => {
    if (jogTimer.current !== undefined) { window.clearTimeout(jogTimer.current); jogTimer.current = undefined; }
    if (jogInterval.current !== undefined) { window.clearInterval(jogInterval.current); jogInterval.current = undefined; }
  }, []);

  const stopJog = useCallback(() => {
    clearJogTimers();
    if (jogging.current) {
      jogging.current = false;
      bumpLiveSync();
      const cam = camNum(selectedCam?.id ?? '01');
      void localPtzStop({ camera: cam });
    }
    jogDir.current = null;
  }, [clearJogTimers, selectedCam, camNum, bumpLiveSync]);

  const panStart = useCallback((dir: PanDir) => {
    clearJogTimers();
    bumpLiveSync();
    setPtzMsg(`ptz ${dir}…`);
    jogDir.current = dir;
    jogging.current = true;
    pressAt.current = Date.now();
    // ONE command for the whole press. There is no tap-versus-hold split any
    // more: the press starts an unbounded move and the release stops it, so a
    // tap is simply a short press.
    //
    // The old shape fired a bounded pulse here and an unbounded move 180ms
    // later. Those are two commands for one gesture, and the second
    // superseded the first while it was still queued — which is exactly what
    // "(busy)" was reporting. Measured: pulse -> SUPERSEDED, hold -> ok. It
    // also made the camera move, stop, pause, then start again.
    void sendMove(dir, 0, ptzVelocity)
      .then((res) => {
        const axes = ptzClampedAxes(res);
        setPtzMsg(axes.length ? `${axes.join('/')} at limit` : `ptz ${dir}`);
      })
      .catch((e: unknown) => setPtzMsg(`move failed: ${formatApiError(e)}`));
    // Refreshes the daemon's 4s safety timeout for as long as this is held.
    jogInterval.current = window.setInterval(() => {
      const cam = camNum(selectedCam?.id ?? '01');
      void localPtzKeepalive(cam).catch(() => { /* best-effort */ });
    }, PTZ_KEEPALIVE_MS);
  }, [clearJogTimers, sendMove, bumpLiveSync, ptzVelocity, selectedCam, camNum]);

  const panEnd = useCallback(() => {
    // Hold the stop back to the minimum press, so a quick tap still travels
    // (see PTZ_MIN_PRESS_MS). Longer presses stop immediately on release.
    const held = Date.now() - pressAt.current;
    const wait = Math.max(0, PTZ_MIN_PRESS_MS - held);
    if (wait === 0) { stopJog(); return; }
    if (jogTimer.current !== undefined) window.clearTimeout(jogTimer.current);
    jogTimer.current = window.setTimeout(() => {
      jogTimer.current = undefined;
      stopJog();
    }, wait);
  }, [stopJog]);

  const clearZoomTimers = useCallback(() => {
    if (zoomJogTimer.current !== undefined) { window.clearTimeout(zoomJogTimer.current); zoomJogTimer.current = undefined; }
    if (zoomJogInterval.current !== undefined) { window.clearInterval(zoomJogInterval.current); zoomJogInterval.current = undefined; }
  }, []);

  const stopZoomJog = useCallback(() => {
    clearZoomTimers();
    if (zoomJogging.current) {
      zoomJogging.current = false;
      bumpLiveSync();
      const cam = camNum(selectedCam?.id ?? '01');
      void localPtzStop({ camera: cam });
    }
    zoomJogDir.current = null;
  }, [clearZoomTimers, selectedCam, camNum, bumpLiveSync]);

  /** Zoom+/Zoom- are hold controls: an immediate tap pulse on press (the
   * existing small, slider-scaled nudge — unchanged), and if held past
   * exactly ONE unbounded continuous-move start at a fixed,
   * fast velocity (decoupled from the drive-speed slider — that's for fine
   * pan/tilt jogging, not zoom holds), kept alive every PTZ_KEEPALIVE_MS
   * until release sends the actual stop (zoomEnd/stopZoomJog). No repeating
   * pulses — that was the stutter this fixes. */
  const zoomStart = useCallback((dir: 1 | -1) => {
    // Same one-command-per-press shape as the pad — the zoom buttons carried
    // an identical copy of the pulse-then-hold pair, and the identical bug.
    clearZoomTimers();
    bumpLiveSync();
    setPtzMsg(dir > 0 ? 'zoom in…' : 'zoom out…');
    zoomJogDir.current = dir;
    zoomJogging.current = true;
    zoomPressAt.current = Date.now();
    void sendMove(null, dir, ZOOM_HOLD_VELOCITY)
      .then((res) => {
        const axes = ptzClampedAxes(res);
        setPtzMsg(axes.length ? 'zoom at limit' : dir > 0 ? 'zoom in' : 'zoom out');
      })
      .catch((e: unknown) => setPtzMsg(`zoom failed: ${formatApiError(e)}`));
    zoomJogInterval.current = window.setInterval(() => {
      const cam = camNum(selectedCam?.id ?? '01');
      void localPtzKeepalive(cam).catch(() => { /* best-effort */ });
    }, PTZ_KEEPALIVE_MS);
  }, [clearZoomTimers, sendMove, bumpLiveSync, selectedCam, camNum]);

  const zoomEnd = useCallback(() => {
    // Same minimum-press floor as the pad, for the same reason.
    const held = Date.now() - zoomPressAt.current;
    const wait = Math.max(0, PTZ_MIN_PRESS_MS - held);
    if (wait === 0) { stopZoomJog(); return; }
    if (zoomJogTimer.current !== undefined) window.clearTimeout(zoomJogTimer.current);
    zoomJogTimer.current = window.setTimeout(() => {
      zoomJogTimer.current = undefined;
      stopZoomJog();
    }, wait);
  }, [stopZoomJog]);

  const captureSnapshot = useCallback(async (camId: string) => {
    try {
      const blob = await fetch(client.snapshotUrl(camNum(camId))).then((r) => r.blob());
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
    const stop = localPtzStop({ camera: cam, home: true });
    void stop
      .then(() => setPtzMsg('home ok'))
      .catch((e: unknown) => setPtzMsg(isSupersededError(e) ? 'home (busy)' : `home failed: ${formatApiError(e)}`));
  }, [selectedCam, camNum, bumpLiveSync]);

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
  // It is a direct hop to the machine that already has the answer, so it can
  // be polled fast enough for the number to track the camera while it turns.
  // And it stays truthful under failure: if the cable is unreachable the
  // readout goes blank rather than quietly aging.
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

  // Held in refs so the effects below can depend on NOTHING and therefore
  // only ever run their cleanup on a real unmount. Depending on the callbacks
  // directly is what made every render fire a stop mid-press.
  const stopJogRef = useRef(stopJog);
  const stopZoomJogRef = useRef(stopZoomJog);
  stopJogRef.current = stopJog;
  stopZoomJogRef.current = stopZoomJog;

  useEffect(() => () => { stopJogRef.current(); stopZoomJogRef.current(); }, []);

  // Continuous holds are now unbounded on the daemon side (no per-pulse
  // auto-stop) — if the window loses focus mid-hold (alt-tab, tab switch)
  // no pointerup ever fires, so stop explicitly. The daemon's own 4s safety
  // timeout is the last-resort backstop (e.g. the tab/process dying outright).
  useEffect(() => {
    const onBlur = () => { stopJogRef.current(); stopZoomJogRef.current(); };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

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

  const utc = formatClockUTC1(now);

  return (
    // hidden, not unmounted — see the `active` prop. The streams stay
    // connected underneath, so returning to the wall is instant instead of a
    // cold restart.
    <div className="app" style={active ? undefined : { display: 'none' }}>
      <header className="topbar">
        <Wordmark />

        <button type="button" className="tower-pill" title={linkLabel}>
          <span className={`tower-pill-dot${connected ? ' live' : ''}`} style={{ background: linkColor, color: linkColor }} />
          <span className="tower-pill-label">{deviceLabel}</span>
          <span className="tower-pill-caret">▾</span>
        </button>

        <nav className="seg-tabs" aria-label="Main sections">
          <button type="button" className={view === 'live' ? 'active' : ''} onClick={() => onSelectView('live')}>Live wall</button>
          <button type="button" className={view === 'recordings' ? 'active' : ''} onClick={() => onSelectView('recordings')}>Recordings</button>
        </nav>

        <div className="topbar-end-group">
          <div className="topbar-clock">
            <div className="topbar-clock-time">{utc}</div>
            <div className="topbar-clock-sub">UTC+1 · CABLE</div>
          </div>
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
                whepUrl={localWhepUrl(c.path)}
                syncLiveTick={c.id === selectedCam?.id ? ptzLiveSyncTick : undefined}
              />
            )
          ))}
        </section>

        {selectedCam && (
          <aside className="control">
            <div className="control-head">
              <div>
                <div className="control-cap">CAMERA UNDER CONTROL</div>
                <div className="control-title">
                  {selectedCam.label}
                  {ptzReadout?.moving && <span className="control-slewing">SLEWING</span>}
                </div>
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

            {/* Which optic the pad actually moves — shown ONLY when it is not
                this tile. A dome shows two tiles and only one can be driven, so
                selecting the fixed view and wondering why the picture will not
                move is a real mistake; but on the PTZ tile the line said
                nothing and cost a row of height the track log needed. */}
            {!selectedCam.ptzCapable && (
              <div
                style={{
                  fontFamily: font.mono, fontSize: 9.5, letterSpacing: '0.06em',
                  color: colors.standby, display: 'flex', gap: 6, alignItems: 'center',
                }}
                title="This is the fixed optic — it cannot move. The pad drives the PTZ optic of the same camera."
              >
                <span>VIEWING FIXED · PAD DRIVES</span>
                <span style={{ color: ACCENT }}>CAM {String(selectedCam.unit).padStart(2, '0')} · PTZ</span>
              </div>
            )}

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
                {aiTrackingBusy ? '…'
                  : aiTracking.armed ? 'ARMED'
                  : !aiTracking.engine_connected ? 'NO ENGINE'
                  : 'OFF'}
              </span>
            </button>

            <div style={{ minHeight: 14, fontFamily: font.mono, fontSize: 10, color: ptzMsg.includes('failed') ? colors.offline : colors.textCaption }}>{ptzMsg}</div>
            <PtzSpeedSlider value={ptzSpeedPct} onChange={(pct) => { setPtzSpeedPct(pct); try { localStorage.setItem(PTZ_SPEED_KEY, String(pct)); } catch { /* */ } }} accent={ACCENT} />
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <PtzPad accent={ACCENT} size="150px" onPanStart={panStart} onPanEnd={panEnd} onRecenter={recenter} />
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

            {/* Where the camera is pointing. Sits under the zoom controls
                because that is where the eye already is while driving the
                PTZ, and it answers "which way am I looking" faster than the
                digits in the readout grid can. */}
            <PtzAttitude
              az={ptzReadout?.az ?? null}
              el={ptzReadout?.el ?? null}
              moving={ptzReadout?.moving}
              accent={ACCENT}
            />
            <TrackLog events={trackEvents} connected={trackConnected} />
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
