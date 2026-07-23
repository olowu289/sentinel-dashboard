import { useCallback, useEffect, useState } from 'react';
import { usePlatform } from './platformContext';
import { formatApiError } from './util';
import {
  deleteRecording,
  getDownloadUrl,
  getPlaybackUrl,
  listRecordings,
  type RecordingSegment,
} from './recordingsApi';

export function useRecordings(
  deviceId: string | undefined,
  opts: { camera?: number; enabled?: boolean } = {},
) {
  const { session } = usePlatform();
  const [segments, setSegments] = useState<RecordingSegment[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const enabled = opts.enabled !== false;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError('');
    try {
      const res = await listRecordings(session, session.customerId, {
        deviceId,
        camera: opts.camera,
        limit: 200,
      });
      setSegments(res.segments);
      setRetentionDays(res.retention_days);
    } catch (e) {
      setError(formatApiError(e, 'Could not load cloud recordings'));
    } finally {
      setLoading(false);
    }
  }, [enabled, session, deviceId, opts.camera]);

  useEffect(() => { void refresh(); }, [refresh]);

  const play = useCallback(async (segmentId: string) => {
    const res = await getPlaybackUrl(session, session.customerId, segmentId);
    return res.url;
  }, [session]);

  const download = useCallback(async (seg: RecordingSegment) => {
    const res = await getDownloadUrl(session, session.customerId, seg.segment_id);
    const a = document.createElement('a');
    a.href = res.url;
    a.download = seg.filename;
    a.rel = 'noopener';
    a.click();
  }, [session]);

  const remove = useCallback(async (segmentId: string) => {
    await deleteRecording(session, session.customerId, segmentId);
    setSegments((rows) => rows.filter((s) => s.segment_id !== segmentId));
  }, [session]);

  return {
    segments,
    retentionDays,
    loading,
    error,
    refresh,
    play,
    download,
    remove,
  };
}
