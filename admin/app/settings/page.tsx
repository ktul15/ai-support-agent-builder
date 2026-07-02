'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface Assistant {
  id: string;
  name: string;
  status: string;
}
interface ApiKey {
  id: string;
  created_at: string;
  last_used_at: string | null;
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export default function SettingsPage() {
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);

  const loadKeys = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/assistants/${id}/api-keys`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { api_keys?: ApiKey[] };
      setKeys(data.api_keys ?? []);
    } catch {
      setKeysError('Could not load API keys.');
    }
  }, []);

  useEffect(() => {
    fetch('/api/assistants')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { assistants?: Assistant[] }) => {
        const a = d.assistants?.[0];
        if (a) {
          setAssistant(a);
          void loadKeys(a.id);
        } else setLoadError('No assistant found for your account.');
      })
      .catch(() => setLoadError('Could not load your assistant.'));
  }, [loadKeys]);

  const togglePublish = useCallback(async () => {
    if (!assistant) return;
    const next = assistant.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED';
    setPublishing(true);
    setPublishError(null);
    try {
      const res = await fetch(`/api/assistants/${assistant.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) setAssistant({ ...assistant, status: next });
      else setPublishError('Could not update publish state. Try again.');
    } catch {
      setPublishError('Could not update publish state. Try again.');
    } finally {
      setPublishing(false);
    }
  }, [assistant]);

  const createKey = useCallback(async () => {
    if (!assistant) return;
    setCreating(true);
    setKeysError(null);
    try {
      const res = await fetch(`/api/assistants/${assistant.id}/api-keys`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        key?: string;
        created_at?: string;
      };
      if (res.ok && data.key && data.id) {
        setNewKey(data.key);
        setKeys((prev) => [
          { id: data.id!, created_at: data.created_at ?? new Date().toISOString(), last_used_at: null },
          ...prev,
        ]);
      } else setKeysError('Could not create a key.');
    } catch {
      setKeysError('Could not create a key.');
    } finally {
      setCreating(false);
    }
  }, [assistant]);

  const revokeKey = useCallback(
    async (keyId: string) => {
      if (!assistant || !window.confirm('Revoke this key? Apps using it will stop working.')) return;
      setRevoking(keyId);
      try {
        const res = await fetch(`/api/assistants/${assistant.id}/api-keys/${keyId}`, {
          method: 'DELETE',
        });
        if (res.ok || res.status === 404) setKeys((prev) => prev.filter((k) => k.id !== keyId));
        else setKeysError('Revoke failed.');
      } catch {
        setKeysError('Revoke failed.');
      } finally {
        setRevoking(null);
      }
    },
    [assistant],
  );

  return (
    <main className="dash">
      <header>
        <h1>Settings</h1>
        <Link href="/dashboard" className="ghost" style={{ textDecoration: 'none' }}>
          ← Dashboard
        </Link>
      </header>
      {loadError && <div className="error">{loadError}</div>}

      {assistant && (
        <>
          <section className="pg-card">
            <h2>Publish</h2>
            {publishError && <div className="error">{publishError}</div>}
            <p className="muted">
              Status:{' '}
              <span className={`badge ${assistant.status === 'PUBLISHED' ? 'ok' : ''}`}>
                {assistant.status}
              </span>
            </p>
            <p className="muted">
              {assistant.status === 'PUBLISHED'
                ? 'Your assistant is live and answering.'
                : 'Draft — publish to let your app query it.'}
            </p>
            <button className="primary" onClick={() => void togglePublish()} disabled={publishing}>
              {publishing
                ? 'Saving…'
                : assistant.status === 'PUBLISHED'
                  ? 'Unpublish'
                  : 'Publish'}
            </button>
          </section>

          <section className="pg-card" style={{ marginTop: 16 }}>
            <div className="doclist-head">
              <h2>API keys</h2>
              <button className="ghost" onClick={() => void createKey()} disabled={creating}>
                {creating ? 'Creating…' : 'Create key'}
              </button>
            </div>
            {keysError && <div className="error">{keysError}</div>}

            {newKey && (
              <div className="newkey">
                <p>
                  <strong>Copy this key now</strong> — it won’t be shown again.
                </p>
                <code>{newKey}</code>
                <button className="ghost" onClick={() => setNewKey(null)}>
                  Dismiss
                </button>
              </div>
            )}

            {keys.length === 0 ? (
              <p className="empty">No API keys yet. Create one to connect your app.</p>
            ) : (
              <table className="doctable">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id}>
                      <td>
                        {/* Row id (NOT key material — the secret is shown only once at creation). */}
                        <code className="muted">Key {k.id.slice(0, 8)}</code>
                      </td>
                      <td className="muted">{fmt(k.created_at)}</td>
                      <td className="muted">{fmt(k.last_used_at)}</td>
                      <td>
                        <button
                          className="ghost"
                          disabled={revoking === k.id}
                          onClick={() => void revokeKey(k.id)}
                        >
                          {revoking === k.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  );
}
