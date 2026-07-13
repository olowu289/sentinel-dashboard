import { createContext, useContext } from 'react';
import type { SentinelClient } from '@sentinel/sdk';
import type { Session } from './session';

export interface PlatformContextValue {
  client: SentinelClient;
  session: Session;
  logout: () => void;
}

export const PlatformContext = createContext<PlatformContextValue | null>(null);

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error('usePlatform outside provider');
  return ctx;
}
