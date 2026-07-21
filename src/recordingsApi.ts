import type { Session } from './session';

export interface RecordingSegment {
  segment_id: string;
  customer_id: string;
  device_id: string;
  camera: number;
  filename: string;
  size_bytes: number;
  sha256_hex?: string | null;
  started_at: string;
  ended_at?: string | null;
  uploaded_at?: string | null;
  duration_sec?: number | null;
}

export interface RecordingListResponse {
  customer_id: string;
  retention_days: number;
  segments: RecordingSegment[];
}

export interface PresignedUrlResponse {
  segment_id: string;
  url: string;
  expires_in: number;
}

function apiUrl(baseUrl: string, path: string, apiKey?: string): string {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  if (!apiKey) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(apiKey)}`;
}

async function apiJson<T>(
  session: Session,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (session.apiKey) headers['X-Kallon-Api-Key'] = session.apiKey;
  const res = await fetch(apiUrl(session.baseUrl, path), { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.detail ?? res.statusText;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return body as T;
}

export function listRecordings(
  session: Session,
  customerId: string,
  params: {
    deviceId?: string;
    camera?: number;
    from?: string;
    to?: string;
    limit?: number;
  } = {},
): Promise<RecordingListResponse> {
  const q = new URLSearchParams();
  if (params.deviceId) q.set('device_id', params.deviceId);
  if (params.camera != null) q.set('camera', String(params.camera));
  if (params.from) q.set('from_ts', params.from);
  if (params.to) q.set('to_ts', params.to);
  if (params.limit != null) q.set('limit', String(params.limit));
  const qs = q.toString();
  return apiJson(
    session,
    `/v1/customers/${encodeURIComponent(customerId)}/recordings${qs ? `?${qs}` : ''}`,
  );
}

export function getPlaybackUrl(
  session: Session,
  customerId: string,
  segmentId: string,
): Promise<PresignedUrlResponse> {
  return apiJson(
    session,
    `/v1/customers/${encodeURIComponent(customerId)}/recordings/${encodeURIComponent(segmentId)}/playback`,
  );
}

export function getDownloadUrl(
  session: Session,
  customerId: string,
  segmentId: string,
): Promise<PresignedUrlResponse> {
  return apiJson(
    session,
    `/v1/customers/${encodeURIComponent(customerId)}/recordings/${encodeURIComponent(segmentId)}/download`,
  );
}

export function deleteRecording(
  session: Session,
  customerId: string,
  segmentId: string,
): Promise<{ status: string; segment_id: string }> {
  return apiJson(
    session,
    `/v1/customers/${encodeURIComponent(customerId)}/recordings/${encodeURIComponent(segmentId)}`,
    { method: 'DELETE' },
  );
}
