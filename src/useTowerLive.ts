import { useEffect, useState } from 'react';
import type { StreamsResponse, StreamPath, RecordingStatus } from '@sentinel/sdk';
import type { StatusResponse } from './apiTypes';
import type { Camera, AlertEvent } from './types';
import { usePlatform } from './platformContext';
import { alertToEvent } from './session';
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

function defaultCameras(): Camera[] {
  return Array.from({ length: CAM_COUNT }, (_, i) => {
    const n = i + 1;
    const id = String(n).padStart(2, '0');
    return {
      id,
      path: `cam${n}`,
      label: `CAM ${id}`,
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

function playlistUrl(baseUrl: string, deviceId: string, camera: number): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/v1/towers/${encodeURIComponent(deviceId)}/live/cam${camera}/index.m3u8`;
}

function whepUrl(baseUrl: string, deviceId: string, camera: number): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/v1/towers/${encodeURIComponent(deviceId)}/webrtc/cam${camera}/whep`;
}

/**
 * One instance of this hook now lives for as long as a tower is selected
 * (see FleetApp) — Live wall/Sensors/Alerts all read from the same call
 * instead of each mounting their own, so switching between them no longer
 * shows a false "disconnected" flash while a fresh instance's first poll
 * is in flight. Switching towers is the only time state should reset,
 * handled by the effect below keyed on deviceId.
 *
 * @param ptzEnabled Gates the PTZ-position poll — only worth running while
 *   the Live wall (the only consumer of camera az/el/zoom) is on screen.
 */
export function useTowerLive(deviceId: string, selectedCamId?: string, ptzEnabled = true): TowerLive {
  const enabled = !!deviceId;
  const { client, session } = usePlatform();
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

  useEffect(() => {
    setStreams(null);
    setStatus(null);
    setConnected(false);
    setLinkError('');
    setPtz({});
    setAlerts([]);
    setRecording(null);
  }, [deviceId]);

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
          setLinkError(formatApiError(e, 'Could not reach tower via hub'));
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
    const cam = parseInt(selectedCamId || '01', 10) || 1;
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
        const list = await client.listAlerts({ customerId: session.customerId, deviceId, limit: 50 });
        setAlerts(list.map(alertToEvent));
      } catch { /* ignore */ }
    };
    void loadHistory();

    const url = client.eventsUrl(session.customerId);
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
        if (raw.device_id && raw.device_id !== deviceId) return;
        setAlerts((prev) => [alertToEvent(raw as Parameters<typeof alertToEvent>[0]), ...prev].slice(0, 200));
      } catch { /* ignore */ }
    };
    return () => es?.close();
  }, [client, session.customerId, deviceId, enabled]);

  const refreshRecording = async () => {
    if (!enabled) return;
    try {
      const s = await client.getRecording(deviceId);
      setRecording(s);
    } catch { /* ignore */ }
  };

  const readyByPath = new Map((streams?.paths ?? []).map((p: StreamPath) => [p.name, !!p.ready]));
  const recOn = !!recording?.enabled;

  const cameras = defaultCameras().map((c) => {
    const ready = readyByPath.get(c.path);
    let cstatus: Camera['status'] = 'STANDBY';
    if (streams?.available) cstatus = ready ? 'ONLINE' : 'OFFLINE';
    const pos = ptz[c.id];
    const camNum = parseInt(c.id, 10) || 1;
    const hls = playlistUrl(session.baseUrl, deviceId, camNum);
    const whep = whepUrl(session.baseUrl, deviceId, camNum);
    return {
      ...c,
      status: cstatus,
      hlsUrl: hls,
      webrtcUrl: whep,
      az: pos?.az ?? null,
      el: pos?.el ?? null,
      zoom: pos?.zoom ?? null,
      ptzMoving: pos?.moving === true,
      ptzLive: !!pos?.live,
      recording: recOn,
    };
  });

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
    hlsUrls,
    webrtcUrls,
    recording,
    refreshRecording,
    setRecordingLocal: setRecording,
  };
}
