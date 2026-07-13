import { useEffect, useMemo, useState } from 'react';
import type { Tower } from './types';
import { towerDisplayName } from './session';
import { usePlatform } from './platformContext';

/** Registry-backed tower list for the selected customer. */
export function useFleet(): {
  towers: Tower[];
  loading: boolean;
  error: string;
  refresh: () => void;
} {
  const { client, session } = usePlatform();
  const [apiTowers, setApiTowers] = useState<Awaited<ReturnType<typeof client.listCustomerTowers>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = () => {
    setLoading(true);
    client.listCustomerTowers(session.customerId)
      .then((t) => { setApiTowers(t); setError(''); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, [client, session.customerId]);

  const towers: Tower[] = useMemo(() => apiTowers.map((t) => ({
    id: t.device_id,
    name: towerDisplayName(t),
    location: t.group_id ?? undefined,
    cameras: [],
    sensors: [],
    alerts: [],
    createdAt: t.enrolled_at ? Date.parse(t.enrolled_at) : Date.now(),
  })), [apiTowers]);

  return { towers, loading, error, refresh };
}
