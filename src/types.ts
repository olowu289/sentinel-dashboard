export type CameraStatus = 'ONLINE' | 'STANDBY' | 'OFFLINE';

export interface Camera {
  id: string;
  path: string;
  label: string;
  status: CameraStatus;
  mjpegUrl?: string;
  hlsUrl?: string;
  az: number;
  el: number;
  zoom: number;
  ptzLive: boolean;
  recording: boolean;
  recStart: number | null;
  homeAz: number;
  homeEl: number;
}

export type SensorLevel = 'ok' | 'warn' | 'crit';
export type SensorGroup =
  | 'ENVIRONMENT' | 'POWER' | 'CONNECTIVITY' | 'CAMERAS' | 'SECURITY' | 'SYSTEM';

interface SensorBase {
  key: string;
  label: string;
  short: string;
  level: SensorLevel;
  group: SensorGroup;
  inBar: boolean;
  detail?: string;
  available?: boolean;
}

export interface NumericSensor extends SensorBase {
  kind: 'numeric';
  value: number;
  unit: string;
  max?: number;
  barGradient?: boolean;
}

export interface StateSensor extends SensorBase {
  kind: 'state';
  state: string;
}

export interface ListSensor extends SensorBase {
  kind: 'list';
  items: Array<{ label: string; up: boolean }>;
}

export type Sensor = NumericSensor | StateSensor | ListSensor;

export type AlertLevel = 'good' | 'warn' | 'bad';

export interface AlertEvent {
  id: string;
  type: string;
  level: AlertLevel;
  /** ISO-8601 UTC from platform (canonical). */
  timestampUtc: string | null;
  /** Human-readable UTC+1 for display. */
  time: string;
  payload: Record<string, unknown>;
  deviceId?: string;
}

export type TowerStatus = CameraStatus;

export interface Tower {
  id: string;
  name: string;
  location?: string;
  cameras: Camera[];
  sensors: Sensor[];
  alerts: AlertEvent[];
  createdAt: number;
}
