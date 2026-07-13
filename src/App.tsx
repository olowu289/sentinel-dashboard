import { useMemo, useState } from 'react';
import { SentinelClient } from '@sentinel/sdk';
import { clearSession, loadSession, type Session } from './session';
import { PlatformContext } from './platformContext';
import Login from './components/Login';
import FleetApp from './FleetApp';
import './styles.css';

export default function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  const ctx = useMemo(() => {
    if (!session) return null;
    const client = new SentinelClient(session.baseUrl, {
      apiKey: session.apiKey,
      // Bound fetch — required in browsers when SDK default was unbound (Illegal invocation).
      fetch: (input, init) => globalThis.fetch(input, init),
    });
    return {
      client,
      session,
      logout: () => { clearSession(); setSession(null); },
    };
  }, [session]);

  if (!session || !ctx) {
    return <Login onLogin={setSession} />;
  }

  return (
    <PlatformContext.Provider value={ctx}>
      <FleetApp />
    </PlatformContext.Provider>
  );
}
