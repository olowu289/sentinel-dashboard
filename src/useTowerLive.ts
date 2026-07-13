import { useEffect, useState } from 'react';
import type { StreamsResponse } from '@sentinel/sdk';
import type { StatusResponse } from './apiTypes';
import type { Camera, AlertEvent } from './types';
import { usePlatform } from './platformContext';
import { alertToEvent } from './session';

const STREAMS_MS = 3000;
const STATUS_MS = 2000;
const SNAPSHOT_MS = 2500;
const PTZ_MS = 2000;
const CAM_COUNT = 4;

export interface TowerLive {
  streams: StreamsResponse | null;
  status: StatusResponse | null;
  connected: boolean;
  cameras: Camera[];
  alerts: AlertEvent[];
  snapshotUrls: Record<string, string>;
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
      az: 0,
      el: 0,
      zoom: 0,
      ptzLive: false,
      recording: false,
      recStart: null,
      homeAz: 0,
      homeEl: 0,
    };
  });
}

export function useTowerLive(deviceId: string): TowerLive {
  const enabled = !!deviceId;
  const { client, session } = usePlatform();
  const [streams, setStreams] = useState<StreamsResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [connected, setConnected] = useState(false);
  const [ptz, setPtz] = useState<Record<string, { az: number; el: number; zoom: number; live: boolean }>>({});
  const [snapshotUrls, setSnapshotUrls] = useState<Record<string, string>>({});
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const pollStreams = async () => {
      try {
        const s = await client.towerStreams(deviceId);
        if (!cancelled) { setStreams(s); setConnected(true); }
      } catch {
        if (!cancelled) { setStreams(null); setConnected(false); }
      }
    };
    const pollStatus = async () => {
      try {
        const s = await client.towerStatus(deviceId) as StatusResponse;
        if (!cancelled) { setStatus(s); setConnected(true); }
      } catch {
        if (!cancelled) setStatus({ available: false });
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
    const pollPtz = async () => {
      const next: typeof ptz = {};
      for (let cam = 1; cam <= CAM_COUNT; cam++) {
        try {
          const r = await client.ptzStatus(deviceId, cam);
          const res = r.result ?? {};
          const id = String(cam).padStart(2, '0');
          const panDeg = res.pan_deg ?? (res.pan != null ? res.pan * 180 : 0);
          const tiltDeg = res.tilt_deg ?? (res.tilt != null ? res.tilt * 45 : 0);
          const zoomRatio = res.zoom_ratio ?? (res.zoom != null ? 1 + res.zoom * 7 : 1);
          next[id] = { az: panDeg, el: tiltDeg, zoom: zoomRatio, live: true };
        } catch { /* camera may be offline */ }
      }
      if (!cancelled) setPtz(next);
    };
    pollPtz();
    const id = setInterval(pollPtz, PTZ_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [client, deviceId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const urls: string[] = [];
    const pollSnaps = async () => {
      for (let cam = 1; cam <= CAM_COUNT; cam++) {
        const path = `cam${cam}`;
        const ready = streams?.paths?.find((p) => p.name === path)?.ready;
        if (streams && !ready) continue;
        try {
          const blob = await client.snapshot(deviceId, cam);
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const cid = String(cam).padStart(2, '0');
          setSnapshotUrls((prev) => {
            const old = prev[cid];
            if (old) URL.revokeObjectURL(old);
            return { ...prev, [cid]: url };
          });
        } catch { /* offline */ }
      }
    };
    pollSnaps();
    const id = setInterval(pollSnaps, SNAPSHOT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [client, deviceId, streams, enabled]);

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
        const raw = JSON.parse(ev.data) as { device_id?: string };
        if (raw.device_id && raw.device_id !== deviceId) return;
        setAlerts((prev) => [alertToEvent(raw as Parameters<typeof alertToEvent>[0]), ...prev].slice(0, 200));
      } catch { /* ignore */ }
    };
    return () => es?.close();
  }, [client, session.customerId, deviceId, enabled]);

  const readyByPath = new Map((streams?.paths ?? []).map((p) => [p.name, !!p.ready]));

  const cameras = defaultCameras().map((c) => {
    const ready = readyByPath.get(c.path);
    let cstatus: Camera['status'] = 'STANDBY';
    if (streams?.available) cstatus = ready ? 'ONLINE' : 'OFFLINE';
    const pos = ptz[c.id];
    const rec = !!streams?.paths?.find((p) => p.name === c.path && p.readers > 0);
    return {
      ...c,
      status: cstatus,
      az: pos?.az ?? 0,
      el: pos?.el ?? 0,
      zoom: pos?.zoom ?? 0,
      ptzLive: !!pos?.live,
      recording: rec,
    };
  });

  return {
    streams,
    status,
    connected,
    cameras,
    alerts,
    snapshotUrls,
  };
}
