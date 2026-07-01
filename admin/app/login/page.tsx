'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { safeInternalPath } from '@/lib/auth';

/** The path to land on after login (from middleware's `?next=`), sanitized. */
function safeNextPath(): string {
  if (typeof window === 'undefined') return '/dashboard';
  return safeInternalPath(new URLSearchParams(window.location.search).get('next'));
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.push(safeNextPath());
        router.refresh();
        return; // navigating away — leave loading true
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Login failed.');
    } catch {
      // Browser -> BFF hop failed (e.g. the dev server blipped).
      setError('Cannot reach the server. Please try again.');
    }
    setLoading(false);
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={onSubmit}>
        <h1>Welcome back</h1>
        <p className="sub">Sign in to your builder dashboard.</p>
        {error && <div className="error">{error}</div>}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="alt">
          New here? <Link href="/signup">Create an account</Link>
        </p>
      </form>
    </main>
  );
}
