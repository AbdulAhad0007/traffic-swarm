'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Car, LogIn } from 'lucide-react';

const MESSAGES = {
  invalid_credentials: 'Incorrect username or password.',
  too_many_attempts: 'Too many failed attempts. Try again in 15 minutes.',
  admin_not_configured: 'The admin login has not been configured on the server.',
};

export default function AdminLogin() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        setPassword('');
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(MESSAGES[body.error] || 'Sign-in is unavailable right now. Please try again.');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-login-wrap">
      <form className="panel admin-login" onSubmit={submit}>
        <div className="sidebar-brand">
          <div className="brand-icon-box"><Car size={18} color="var(--accent)" /></div>
          <div className="brand-text">
            <span className="brand-title">TRAFFIC SWARM</span>
            <span className="brand-sub">Admin Console</span>
          </div>
        </div>
        <h1>Sign in</h1>
        <label>Username
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label>Password
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" disabled={busy}><LogIn size={15} /> {busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
