'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function SignupPage() {
  const router = useRouter();
  const [tenantName, setTenantName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantName, email, password }),
      });
      if (res.ok) {
        router.push('/dashboard');
        router.refresh();
        return; // navigating away — leave loading true
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Sign up failed.');
    } catch {
      setError('Cannot reach the server. Please try again.');
    }
    setLoading(false);
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={onSubmit}>
        <h1>Create your workspace</h1>
        <p className="sub">Start building your support assistant.</p>
        {error && <div className="error">{error}</div>}
        <label className="field">
          <span>Business name</span>
          <input value={tenantName} onChange={(e) => setTenantName(e.target.value)} required />
        </label>
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
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Creating…' : 'Create account'}
        </button>
        <p className="alt">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
