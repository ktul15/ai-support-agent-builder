'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { INGEST_STEPS, isTerminalStatus, statusLabel, stepIndex } from '@/lib/documents';

interface UploadItem {
  key: string;
  fileName: string;
  file: File;
  status: string; // 'uploading' | 'error' | an IngestStatus from the stream
  error?: string;
  docId?: string;
}

interface DocumentView {
  id: string;
  title: string;
  status: string;
  chunkCount: number;
  updatedAt: string;
}

let counter = 0;
const nextKey = (): string => `u${Date.now()}-${counter++}`;

export default function DocumentsPage() {
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const streams = useRef<Map<string, EventSource>>(new Map());
  const [documents, setDocuments] = useState<DocumentView[]>([]);
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/assistants')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { assistants?: { id: string }[] }) => {
        const id = d.assistants?.[0]?.id;
        if (id) setAssistantId(id);
        else setLoadError('No assistant found for your account.');
      })
      .catch(() => setLoadError('Could not load your assistant. Try reloading.'));
  }, []);

  // Close all live streams on unmount.
  useEffect(() => {
    const map = streams.current;
    return () => map.forEach((es) => es.close());
  }, []);

  const patch = useCallback((key: string, next: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...next } : it)));
  }, []);

  const fetchDocuments = useCallback(async () => {
    if (!assistantId) return;
    try {
      const res = await fetch(`/api/documents?assistantId=${assistantId}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { documents?: DocumentView[] };
      setDocuments(data.documents ?? []);
      setDocsError(null);
    } catch {
      setDocsError('Could not load your documents.');
    } finally {
      setDocsLoaded(true);
    }
  }, [assistantId]);

  const deleteDoc = useCallback(async (id: string, title: string) => {
    if (!window.confirm(`Delete “${title}”? This removes it from your assistant.`)) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
      // 404 = already gone elsewhere -> drop it too (delete is idempotent).
      if (res.ok || res.status === 404) setDocuments((prev) => prev.filter((d) => d.id !== id));
      else setDocsError('Delete failed. Try again.');
    } catch {
      setDocsError('Delete failed. Try again.');
    } finally {
      setDeletingId(null);
    }
  }, []);

  const watch = useCallback(
    (key: string, docId: string) => {
      streams.current.get(key)?.close();
      const es = new EventSource(`/api/documents/${docId}/events`);
      streams.current.set(key, es);
      const close = (): void => {
        es.close();
        streams.current.delete(key); // evict so the map doesn't grow unbounded
      };

      es.addEventListener('status', (e) => {
        let data: { status: string; error?: string | null };
        try {
          data = JSON.parse((e as MessageEvent).data);
        } catch {
          return; // ignore a malformed frame
        }
        // Carry the failure reason so a FAILED row can show it (and offer Retry).
        patch(key, {
          status: data.status,
          error: data.status === 'FAILED' ? (data.error ?? 'Ingestion failed.') : undefined,
        });
      });
      es.addEventListener('done', () => {
        close();
        // Ingestion reached a terminal state — drop the transient row and let it
        // appear in the persistent list with its final status + chunk count.
        setItems((prev) => prev.filter((it) => it.key !== key));
        void fetchDocuments();
      });
      es.addEventListener('timeout', () => {
        patch(key, { status: 'error', error: 'Timed out — the document may still be processing.' });
        close();
      });
      es.addEventListener('error', (e) => {
        // A named API error carries data; a transport blip does not. Either way,
        // only surface it if we haven't already reached a terminal state.
        setItems((prev) =>
          prev.map((it) => {
            if (it.key !== key) return it;
            if (isTerminalStatus(it.status)) return it;
            const data = (e as MessageEvent).data;
            const msg = data ? 'The server reported a problem.' : 'Lost connection to the server.';
            return { ...it, status: 'error', error: msg };
          }),
        );
        close();
      });
    },
    [patch, fetchDocuments],
  );

  const upload = useCallback(
    async (item: UploadItem) => {
      if (!assistantId) return;
      patch(item.key, { status: 'uploading', error: undefined });
      const form = new FormData();
      form.append('assistantId', assistantId);
      form.append('file', item.file);
      try {
        const res = await fetch('/api/documents', { method: 'POST', body: form });
        const data = (await res.json().catch(() => ({}))) as { documentId?: string; error?: string };
        if (res.ok && data.documentId) {
          patch(item.key, { status: 'UPLOADED', docId: data.documentId });
          watch(item.key, data.documentId);
        } else {
          patch(item.key, { status: 'error', error: data.error ?? `Upload failed (${res.status}).` });
        }
      } catch {
        patch(item.key, { status: 'error', error: 'Cannot reach the server.' });
      }
    },
    [assistantId, patch, watch],
  );

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || !assistantId) return;
      const newItems: UploadItem[] = Array.from(files).map((file) => ({
        key: nextKey(),
        fileName: file.name,
        file,
        status: 'uploading',
      }));
      setItems((prev) => [...newItems, ...prev]);
      newItems.forEach((it) => void upload(it));
    },
    [assistantId, upload],
  );

  // Load the persistent document list once the assistant is known.
  useEffect(() => {
    if (assistantId) void fetchDocuments();
  }, [assistantId, fetchDocuments]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  // Hide list rows for docs still shown as live transient uploads, so a Refresh
  // mid-ingest doesn't render the same document twice.
  const inFlightDocIds = new Set(items.map((it) => it.docId).filter(Boolean));
  const listDocs = documents.filter((d) => !inFlightDocIds.has(d.id));

  return (
    <main className="dash">
      <header>
        <h1>Documents</h1>
        <Link href="/dashboard" className="ghost" style={{ textDecoration: 'none' }}>
          ← Dashboard
        </Link>
      </header>

      {loadError && <div className="error">{loadError}</div>}

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <p>
          <strong>Drop documents here</strong> or click to browse
        </p>
        <p className="hint">PDF, DOCX, TXT — multiple at once.</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          disabled={!assistantId}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <ul className="uploads">
        {items.map((it) => (
          <li key={it.key} className="upload-row">
            <div className="upload-main">
              <span className="fname" title={it.fileName}>
                {it.fileName}
              </span>
              <StatusBadge item={it} />
            </div>
            {it.status === 'error' || it.status === 'FAILED' ? (
              <div className="row-error">
                <span>{it.error ?? 'Something went wrong.'}</span>
                <button className="ghost" onClick={() => void upload(it)}>
                  Retry
                </button>
              </div>
            ) : (
              <Steps status={it.status} />
            )}
          </li>
        ))}
      </ul>

      <section className="doclist">
        <div className="doclist-head">
          <h2>Your documents</h2>
          <button className="ghost" onClick={() => void fetchDocuments()} disabled={!assistantId}>
            Refresh
          </button>
        </div>
        {docsError && <div className="error">{docsError}</div>}
        {docsLoaded && listDocs.length === 0 && items.length === 0 ? (
          <p className="empty">No documents yet. Upload some above to get started.</p>
        ) : listDocs.length === 0 ? null : (
          <table className="doctable">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Chunks</th>
                <th>Updated</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {listDocs.map((d) => (
                <tr key={d.id}>
                  <td className="fname" title={d.title}>
                    {d.title}
                  </td>
                  <td>
                    <DocBadge status={d.status} />
                  </td>
                  <td>{d.chunkCount}</td>
                  <td className="muted">{formatDate(d.updatedAt)}</td>
                  <td>
                    <button
                      className="ghost"
                      disabled={deletingId === d.id}
                      onClick={() => void deleteDoc(d.id, d.title)}
                    >
                      {deletingId === d.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function DocBadge({ status }: { status: string }) {
  const cls = status === 'READY' ? ' ok' : status === 'FAILED' ? ' bad' : '';
  return <span className={`badge${cls}`}>{statusLabel(status)}</span>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

function StatusBadge({ item }: { item: UploadItem }) {
  if (item.status === 'uploading') return <span className="badge">Uploading…</span>;
  if (item.status === 'error' || item.status === 'FAILED')
    return <span className="badge bad">Failed</span>;
  if (item.status === 'READY') return <span className="badge ok">Ready</span>;
  return <span className="badge">{statusLabel(item.status)}</span>;
}

function Steps({ status }: { status: string }) {
  const current = status === 'uploading' ? 0 : stepIndex(status);
  return (
    <div className="steps">
      {INGEST_STEPS.map((step, i) => (
        <span
          key={step}
          className={`step${i < current ? ' done' : ''}${i === current ? ' active' : ''}`}
        >
          {statusLabel(step)}
        </span>
      ))}
    </div>
  );
}
