import { useState, type FormEvent } from 'react';
import { DEFAULT_CUSTOMER_ID, PLATFORM_URL } from '../config';
import { colors, font } from '../tokens';
import { saveSession, type Session } from '../session';

interface Props {
  onLogin: (s: Session) => void;
}

export default function Login({ onLogin }: Props) {
  const [baseUrl, setBaseUrl] = useState(PLATFORM_URL);
  const [apiKey, setApiKey] = useState('');
  const [customerId, setCustomerId] = useState(DEFAULT_CUSTOMER_ID);
  const [error, setError] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const s: Session = {
      // Empty field → central PLATFORM_URL (change once in src/config.ts / VITE_PLATFORM_URL).
      baseUrl: (baseUrl || PLATFORM_URL).replace(/\/$/, ''),
      apiKey: apiKey.trim(),
      customerId: customerId.trim(),
    };
    if (!s.baseUrl || !s.apiKey || !s.customerId) {
      setError('All fields are required.');
      return;
    }
    saveSession(s);
    onLogin(s);
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span style={{ fontFamily: font.display, fontSize: 28, letterSpacing: '.2em', color: colors.textBright }}>SENTINEL</span>
        </div>
        <label>
          <span>Control plane URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={PLATFORM_URL} autoComplete="url" />
        </label>
        <label>
          <span>API key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="X-Kallon-Api-Key" autoComplete="current-password" />
        </label>
        <label>
          <span>Customer ID</span>
          <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder={DEFAULT_CUSTOMER_ID} />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="login-btn">Sign in</button>
        <p className="login-hint">
          API origin from <code>src/config.ts</code> / <code>VITE_PLATFORM_URL</code>.
          SDK + live HLS both use the session URL — change once to retarget the control plane.
        </p>
      </form>
    </div>
  );
}
