'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort: even if the request fails, send the user to /login (the
      // middleware will bounce them back here only if the cookie survived).
    } finally {
      router.push('/login');
      router.refresh();
      setBusy(false);
    }
  }
  return (
    <button className="ghost" onClick={logout} disabled={busy}>
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
