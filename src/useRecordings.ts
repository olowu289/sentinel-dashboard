import { useCallback, useEffect, useState } from 'react';
import { LOCAL_CONTROL_HOST } from './videoSourceMode';

/**
 * Recordings from the tower's own disk, over the cable.
 *
 * The platform version listed segments that had been UPLOADED to cloud
 * storage, and played them back through presigned URLs scoped to a tenant.
 * None of that applies here: the footage is on an NVMe a metre away, there is
 * no tenant to isolate, and a presigned URL is a way of granting access
 * across a trust boundary that no longer exists.
 *
 * The trade is real and worth stating: cloud retention outlived the tower,
 * so footage survived the hardware being seized or destroyed. Local-only
 * recording does not. That is a deliberate consequence of removing the
 * platform, not an oversight.
 */

export interface LocalSegment {
  camera: number;
  filename: string;
  rel_path: string;
  size_bytes: number;
  mtime_utc: string;
  playback_url: string;
}

interface LocalRecordingsResponse {
  record_path?: string;
  segments?: LocalSegment[];
  delete_after_effective?: string;
  segment_duration?: string;
  error?: string;
}

export function useRecordings(camera?: number) {
  const [segments, setSegments] = useState<LocalSegment[]>([]);
  const [meta, setMeta] = useState<LocalRecordingsResponse>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ limit: '500' });
      if (camera) qs.set('camera', String(camera));
      const res = await fetch(`http://${LOCAL_CONTROL_HOST}/api/recordings?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as LocalRecordingsResponse;
      setSegments(data.segments ?? []);
      setMeta(data);
      if (data.error) setError(data.error);
    } catch (e) {
      // Blank, not stale: an empty list the operator can see is honest,
      // a list left over from the last successful poll is not.
      setSegments([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [camera]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Absolute URL for a segment on this tower. Plain GET with Range support -
   * no signing, because there is no boundary to sign across. */
  const url = useCallback(
    (s: LocalSegment) => (s.playback_url.startsWith('http')
      ? s.playback_url
      : `http://${LOCAL_CONTROL_HOST}${s.playback_url}`),
    [],
  );

  return { segments, meta, loading, error, refresh, url };
}
