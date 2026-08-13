import { createContext, useContext } from 'react';
import type { TowerClient } from './towerClient';

export interface TowerContextValue {
  client: TowerClient;
}

export const TowerContext = createContext<TowerContextValue | null>(null);

export function useTower(): TowerContextValue {
  const ctx = useContext(TowerContext);
  if (!ctx) throw new Error('useTower outside provider');
  return ctx;
}
