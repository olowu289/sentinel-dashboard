import type { StreamsResponse } from '@sentinel/sdk';

export interface StreamPath {
  name: string;
  ready: boolean;
  readers: number;
  source: string | null;
}

export interface StatusResponse {
  available?: boolean;
  error?: string;
  device_id?: string;
  poll_interval_sec?: number;
  mpu_present?: boolean;
  uptime_sec?: number;
  timestamp_utc?: string;
  door?: { open: boolean | null };
  light?: { exposed: boolean | null };
  impact?: {
    threshold_mg?: number | null;
    last_delta_mg?: number | null;
    last_impact_utc?: string | null;
  };
  temperature?: {
    celsius?: number | null;
    zone?: string | null;
    critical?: boolean;
    trigger_c?: number;
    clear_c?: number;
  };
  disk?: {
    enabled?: boolean;
    faulted?: boolean;
    space_free_gb?: number | null;
    space_total_gb?: number | null;
    space_used_gb?: number | null;
    percentage_used?: number | null;
    available_spare?: number | null;
    smart_temp_c?: number | string | null;
  };
  streams?: Array<{ path: string; ok: boolean }>;
}

export type { StreamsResponse };
