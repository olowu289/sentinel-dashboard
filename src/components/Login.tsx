import { useState, type FormEvent } from 'react';
import { colors, font } from '../tokens';
import { saveSession, type Session } from '../session';

const DEFAULT_BASE = import.meta.env.VITE_PLATFORM_URL ?? '';

interface Props {
  onLogin: (s: Session) => void;
}

export default function Login({ onLogin }: Props) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const [apiKey, setApiKey] = useState('');
  const [customerId, setCustomerId] = useState('cust_acme');
  const [error, setError] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const s: Session = {
      baseUrl: (baseUrl || '').replace(/\/$/, '') || window.location.origin,
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
          <span style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: '.2em', color: colors.textFaint }}>TERRA DASHBOARD</span>
        </div>
        <label>
          <span>Control plane URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.terra.example" autoComplete="url" />
        </label>
        <label>
          <span>API key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="X-Kallon-Api-Key" autoComplete="current-password" />
        </label>
        <label>
          <span>Customer ID</span>
          <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="cust_acme" />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="login-btn">Sign in</button>
        <p className="login-hint">Uses the Kallon Platform API (`/v1`). Towers appear from registry after enrollment.</p>
      </form>
    </div>
  );
}
