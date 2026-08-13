import { useEffect, useMemo, useState } from 'react';
import type { StreamsResponse, StreamPath, RecordingStatus } from '@sentinel/sdk';
import type { StatusResponse } from './apiTypes';
import type { Camera, AlertEvent } from './types';
import { useTower } from './towerContext';
import type { TowerConfig } from './towerClient';
import { localWhepUrl } from './videoSourceMode';
import { alertToEvent } from './alerts';
import { formatApiError } from './util';

/** Keep Artemis/ngrok load low — multi-cam HLS + PTZ spam causes cascade failures. */
const STREAMS_MS = 8000;
const STATUS_MS = 8000;
const PTZ_MS = 3000;
const RECORDING_MS = 10000;
const CAM_COUNT = 4;

/**
 * The most recent external (non-AI-bridge) target-cueing alert, from ANY
 * tower on this customer's account — deliberately not filtered to the
 * currently-selected tower, unlike `alerts` below. The SSE stream itself is
 * already customer-scoped (see the effect below), so this needs no separate
 * subscription; it just doesn't throw away events for towers you aren't
 * currently looking at. Consumers decide when it's "expired" themselves
 * (compare `receivedAtMs + holdSeconds*1000` against the current time) —
 * this hook only ever replaces it with whatever arrived most recently.
 */
export interface TargetCueAlert {
  deviceId: string;
  camera: number;
  origin: string;
  label: string;
  source: string;
  holdSeconds: number;
  receivedAtMs: number;
}

export interface TowerLive {
  streams: StreamsResponse | null;
  status: StatusResponse | null;
  connected: boolean;
  /** Last hop-specific error from status/streams poll (empty when linked). */
  linkError: string;
  cameras: Camera[];
  alerts: AlertEvent[];
  targetCueAlert: TargetCueAlert | null;
  /** Platform HLS playlist URLs keyed by camera id ("01"…"04"). */
  hlsUrls: Record<string, string>;
  /** Platform WHEP create-session URLs keyed by camera id ("01"…"04"). */
  webrtcUrls: Record<string, string>;
  /** Continuous NVR recording status from Platform API (null while unknown). */
  recording: RecordingStatus | null;
  refreshRecording: () => Promise<void>;
  setRecordingLocal: (s: RecordingStatus | null) => void;
}

/**
 * Cameras as the TOWER describes them (GET /api/config), not as this app
 * assumes them.
 *
 * The platform build hardcoded four, because the fleet API did not carry a
 * per-tower camera list and four was the standard build. On a cable the
 * tower can simply be asked, so a three-camera or six-camera tower renders
 * correctly instead of showing phantom tiles that will never come online.
 * The hardcoded list survives only as the pre-answer placeholder.
 */
function camerasFrom(cfg: TowerConfig | null): Camera[] {
  if (!cfg?.cameras?.length) return defaultCameras();

  // TWO TILES PER DOME. Each camera carries a PTZ optic and a fixed wide one
  // on separate channels. The PTZ optics are emitted first as a block, then
  // the fixed ones, so a two-column grid reads as one camera per column with
  // the drivable view on top and its fixed companion directly beneath it.
  const ptz: Camera[] = [];
  const fixed: Camera[] = [];

  for (const c of cfg.cameras) {
    const n = c.camera;
    const id = String(n).padStart(2, '0');
    ptz.push({
      id, unit: n, path: c.path, label: `CAM ${id}`,
      lens: 'ptz', ptzCapable: c.ptz_capable !== false,
      status: 'STANDBY',
      az: null, el: null, zoom: null, ptzLive: false,
      recording: false, recStart: null, homeAz: 0, homeEl: 0,
    });
    if (c.fixed?.path) {
      fixed.push({
        id: `${id}F`, unit: n, path: c.fixed.path, label: `CAM ${id} FIXED`,
        lens: 'fixed', ptzCapable: false,
        status: 'STANDBY',
        az: null, el: null, zoom: null, ptzLive: false,
        recording: false, recStart: null, homeAz: 0, homeEl: 0,
      });
    }
  }
  return [...ptz, ...fixed];
}

function defaultCameras(): Camera[] {
  return Array.from({ length: CAM_COUNT }, (_, i) => {
    const n = i + 1;
    const id = String(n).padStart(2, '0');
    return {
      id,
      unit: n,
      path: `cam${n}`,
      label: `CAM ${id}`,
      lens: 'ptz' as const,
      ptzCapable: true,
      status: 'STANDBY',
      az: null,
      el: null,
      zoom: null,
      ptzLive: false,
      recording: false,
      recStart: null,
      homeAz: 0,
      homeEl: 0,
    };
  });
}

/**
 * Video comes straight off the tower's own MediaMTX on the LAN.
 *
 * The platform equivalents built /v1/towers/{id}/live/... URLs that were
 * proxied through the hub - an extra network hop, and one that only existed
 * so a remote browser could reach a tower it had no route to. On a cable
 * there is a route, so the hop is pure latency.
 *
 * HLS is deliberately not offered. It buys reach through hostile networks at
 * the cost of seconds of buffering; on the same switch there is no hostile
 * network to survive, and seconds of latency is the one thing this product
 * cannot spend. WHEP only.
 */

export function useTowerLive(deviceId: string, selectedCamId?: string, ptzEnabled = true): TowerLive {
  // Always enabled: there is one tower and we are plugged into it. The old
  // gate was `!!deviceId`, which existed because the fleet could hand down an
  // empty selection before it had loaded. Nothing can be unselected now.
  const enabled = true;
  const { client } = useTower();
  const [streams, setStreams] = useState<StreamsResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [ptz, setPtz] = useState<Record<string, {
    az: number | null; el: number | null; zoom: number | null;
    moving?: boolean; live: boolean;
  }>>({});
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [targetCueAlert, setTargetCueAlert] = useState<TargetCueAlert | null>(null);
  const [recording, setRecording] = useState<RecordingStatus | null>(null);
  const [config, setConfig] = useState<TowerConfig | null>(null);

  useEffect(() => {
    setStreams(null);
    setStatus(null);
    setConnected(false);
    setLinkError('');
    setPtz({});
    setAlerts([]);
    setRecording(null);
  }, [deviceId]);

  // Asked once: a tower's camera complement does not change while you are
  // looking at it.
  useEffect(() => {
    let cancelled = false;
    client.config().then((c) => { if (!cancelled) setConfig(c); }).catch(() => { /* placeholder list stands in */ });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const pollStreams = async () => {
      try {
        const s = await client.towerStreams(deviceId);
        if (!cancelled) { setStreams(s); setConnected(true); setLinkError(''); }
      } catch (e) {
        if (!cancelled) {
          setStreams(null);
          setConnected(false);
          setLinkError(formatApiError(e, 'Could not reach the tower — check the cable'));
        }
      }
    };
    const pollStatus = async () => {
      try {
        const s = await client.towerStatus(deviceId) as StatusResponse;
        if (!cancelled) { setStatus(s); setConnected(true); setLinkError(''); }
      } catch (e) {
        if (!cancelled) {
          setStatus({ available: false });
          setLinkError(formatApiError(e, 'Could not reach tower via hub'));
        }
      }
    };
    pollStreams();
    pollStatus();
    const a = setInterval(pollStreams, STREAMS_MS);
    const b = setInterval(pollStatus, STATUS_MS);
    return () => { cancelled = true; clearInterval(a); clearInterval(b); };
  }, [client, deviceId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const s = await client.getRecording(deviceId);
        if (!cancelled) setRecording(s);
      } catch {
        /* leave last known */
      }
    };
    void pull();
    const id = setInterval(pull, RECORDING_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [client, deviceId, enabled]);

  // PTZ: only the selected camera (was 4 cams × 2s ≈ Artemis/ngrok saturation),
  // and only while ptzEnabled (Live wall is the only view that shows az/el/zoom).
  useEffect(() => {
    if (!enabled || !ptzEnabled) return;
    // A fixed optic has no position of its own: it shares the dome with the
    // PTZ one but nothing moves it. Poll by DOME number, never by tile id -
    // the fixed tiles carry ids like "01F".
    const cam = parseInt((selectedCamId || '01').replace(/\D/g, ''), 10) || 1;
    let cancelled = false;
    const pollPtz = async () => {
      try {
        const r = await client.ptzStatus(deviceId, cam);
        const res = r.result ?? {};
        const id = String(cam).padStart(2, '0');
        // Taken as reported or not at all. The tower sends real degrees
        // (the camera's own) and omits the field entirely when it has
        // nothing - so a missing value stays missing rather than being
        // back-filled from the normalized ONVIF number, which is what used
        // to put a wrong-by-2-3x elevation on screen.
        const withMoving = res as typeof res & { moving?: boolean };
        const panDeg = res.pan_deg ?? null;
        const tiltDeg = res.tilt_deg ?? null;
        const zoomRatio = res.zoom_ratio ?? null;
        if (!cancelled) {
          setPtz((prev) => ({
            ...prev,
            [id]: {
              az: panDeg, el: tiltDeg, zoom: zoomRatio,
              moving: withMoving.moving === true,
              live: panDeg != null || tiltDeg != null,
            },
          }));
        }
      } catch { /* camera may be offline */ }
    };
    pollPtz();
    const id = setInterval(pollPtz, PTZ_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [client, deviceId, enabled, selectedCamId, ptzEnabled]);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    const loadHistory = async () => {
      try {
        // No backlog to fetch. The gateway streams alerts as they occur and
        // keeps no history, so the list starts empty and fills from the live
        // feed below. An operator who connects late has genuinely missed
        // what happened before - better that than a list that looks
        // complete and is not.
        const list: never[] = [];
        setAlerts(list.map(alertToEvent));
      } catch { /* ignore */ }
    };
    void loadHistory();

    const url = client.eventsUrl();
    es = new EventSource(url);
    es.onmessage = (ev) => {
      try {
        const raw = JSON.parse(ev.data) as {
          device_id?: string;
          alert_type?: string;
          details?: Record<string, unknown>;
        };
        // Cross-tower on purpose — checked before the per-tower filter below,
        // so a target_cued alert from a tower you're NOT currently viewing
        // still surfaces (see TargetCueAlert's own comment above).
        if (raw.alert_type === 'target_cued' && raw.device_id) {
          const d = raw.details ?? {};
          setTargetCueAlert({
            deviceId: raw.device_id,
            camera: Number(d.camera) || 1,
            origin: typeof d.origin === 'string' ? d.origin : 'unknown',
            label: typeof d.label === 'string' ? d.label : '',
            source: typeof d.source === 'string' ? d.source : '',
            holdSeconds: Number(d.hold_seconds) || 0,
            receivedAtMs: Date.now(),
          });
        }
        // No device filter: every alert arriving on this socket came from
        // the tower we are plugged into, by definition.
        setAlerts((prev) => [alertToEvent(raw as Parameters<typeof alertToEvent>[0]), ...prev].slice(0, 200));
      } catch { /* ignore */ }
    };
    return () => es?.close();
  }, [client, enabled]);

  const refreshRecording = async () => {
    if (!enabled) return;
    try {
      const s = await client.getRecording(deviceId);
      setRecording(s);
    } catch { /* ignore */ }
  };

  const recOn = !!recording?.enabled;

  // MEMOISED DELIBERATELY, not for speed. Rebuilding this array on every
  // render gave it a new identity every render, and identity propagates:
  // callbacks that close over `cameras` are rebuilt too, and any effect that
  // depends on those callbacks re-runs its CLEANUP every render. One such
  // cleanup stopped the camera, so holding a PTZ button was interrupted about
  // once a second by the UI itself. Keep this stable.
  const cameras = useMemo(() => {
  const readyByPath = new Map((streams?.paths ?? []).map((p: StreamPath) => [p.name, !!p.ready]));
  return camerasFrom(config).map((c) => {
    const ready = readyByPath.get(c.path);
    let cstatus: Camera['status'] = 'STANDBY';
    if (streams?.available) cstatus = ready ? 'ONLINE' : 'OFFLINE';
    const pos = ptz[c.id];
    const whep = localWhepUrl(c.path);
    return {
      ...c,
      status: cstatus,
      webrtcUrl: whep,
      az: pos?.az ?? null,
      el: pos?.el ?? null,
      zoom: pos?.zoom ?? null,
      ptzMoving: pos?.moving === true,
      ptzLive: !!pos?.live,
      recording: recOn,
    };
  });
  }, [config, streams, ptz, recOn]);

  const hlsUrls: Record<string, string> = {};
  const webrtcUrls: Record<string, string> = {};
  for (const c of cameras) {
    if (c.hlsUrl) hlsUrls[c.id] = c.hlsUrl;
    if (c.webrtcUrl) webrtcUrls[c.id] = c.webrtcUrl;
  }

  return {
    streams,
    status,
    connected,
    linkError,
    cameras,
    alerts,
    targetCueAlert,
    hlsUrls: {},
    webrtcUrls,
    recording,
    refreshRecording,
    setRecordingLocal: setRecording,
  };
}
