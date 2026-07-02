'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { parseSseFrames } from '@/lib/sse';

interface Citation {
  marker: number;
  document_id: string;
  title: string;
  page: number | null;
  section: string | null;
  snippet: string;
}
interface RetrievedChunk {
  id: string;
  title: string;
  page: number | null;
  section: string | null;
  score: number;
  snippet: string;
}
interface Debug {
  threshold: number;
  decision: { refuse: boolean; reason: string | null; top_score: number | null };
  retrieved: RetrievedChunk[];
  assembled: { total_tokens: number } | null;
}

export default function PlaygroundPage() {
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.35); // persisted value
  const [tuned, setTuned] = useState(0.35); // slider value
  const [loadError, setLoadError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState('');
  const [answerErr, setAnswerErr] = useState<string | null>(null);
  const [grounded, setGrounded] = useState<boolean | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [debug, setDebug] = useState<Debug | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch('/api/assistants')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { assistants?: { id: string; refusal_threshold: number }[] }) => {
        const a = d.assistants?.[0];
        if (a) {
          setAssistantId(a.id);
          setThreshold(a.refusal_threshold);
          setTuned(a.refusal_threshold);
        } else setLoadError('No assistant found for your account.');
      })
      .catch(() => setLoadError('Could not load your assistant.'));
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const runRetrieve = useCallback(
    async (q: string) => {
      try {
        const res = await fetch('/api/playground/retrieve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assistantId, question: q }),
        });
        if (!res.ok) {
          setDebug(null);
          return;
        }
        const d = (await res.json()) as Debug;
        setDebug(d);
        setThreshold(d.threshold);
        setTuned(d.threshold);
      } catch {
        setDebug(null); // never reject — onSubmit's finally still runs
      }
    },
    [assistantId],
  );

  const runChat = useCallback(
    async (q: string) => {
      abortRef.current?.abort(); // cancel any still-running stream first
      setAnswer('');
      setAnswerErr(null);
      setGrounded(null);
      setCitations([]);
      const ac = new AbortController();
      abortRef.current = ac;
      let res: Response;
      try {
        res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assistantId, question: q }),
          signal: ac.signal,
        });
      } catch {
        setAnswerErr('Cannot reach the server.');
        return;
      }
      if (!res.ok || !res.body) {
        setAnswerErr('Chat failed.');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let acc = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseFrames(buffer);
          buffer = rest;
          for (const f of frames) {
            try {
              if (f.event === 'token') {
                acc += (JSON.parse(f.data) as { text: string }).text;
                setAnswer(acc);
              } else if (f.event === 'done') {
                const d = JSON.parse(f.data) as { grounded: boolean; citations: Citation[] };
                setGrounded(d.grounded);
                setCitations(d.citations ?? []);
              } else if (f.event === 'error') {
                setAnswerErr('Generation failed.');
              }
            } catch {
              // skip a malformed frame; keep reading the rest of the stream
            }
          }
        }
      } catch {
        // aborted or stream error — leave whatever streamed so far
      }
    },
    [assistantId],
  );

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const q = question.trim();
      if (!assistantId || !q || running) return;
      setRunning(true);
      try {
        await Promise.all([runRetrieve(q), runChat(q)]);
      } finally {
        setRunning(false); // never wedge the button, even if a call rejects
      }
    },
    [assistantId, question, running, runRetrieve, runChat],
  );

  const saveThreshold = useCallback(async () => {
    if (!assistantId) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      const res = await fetch(`/api/assistants/${assistantId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refusalThreshold: tuned }),
      });
      if (res.ok) {
        setThreshold(tuned);
        setSavedMsg('Saved.');
      } else setSavedMsg('Save failed.');
    } catch {
      setSavedMsg('Save failed.');
    } finally {
      setSaving(false);
    }
  }, [assistantId, tuned]);

  const topScore = debug?.decision.top_score ?? null;
  const tunedRefuse = topScore === null || topScore < tuned;

  return (
    <main className="dash">
      <header>
        <h1>Playground</h1>
        <Link href="/dashboard" className="ghost" style={{ textDecoration: 'none' }}>
          ← Dashboard
        </Link>
      </header>
      {loadError && <div className="error">{loadError}</div>}

      <form onSubmit={onSubmit} className="pg-ask">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask your assistant a question…"
          disabled={!assistantId}
        />
        <button
          className="primary"
          type="submit"
          disabled={!assistantId || running || !question.trim()}
        >
          {running ? 'Testing…' : 'Test'}
        </button>
      </form>

      <div className="pg-grid">
        <section className="pg-card">
          <h2>Answer</h2>
          {answerErr && <div className="error">{answerErr}</div>}
          <div className="answer-body">
            {answer || <span className="muted">The streamed answer appears here.</span>}
          </div>
          {grounded !== null && <p className="muted">grounded: {String(grounded)}</p>}
          {citations.length > 0 && (
            <ol className="citations">
              {citations.map((c) => (
                <li key={c.marker}>
                  <strong>
                    [{c.marker}] {c.title}
                  </strong>
                  {c.page != null ? `, p.${c.page}` : ''}
                  <br />
                  <span className="muted">{c.snippet}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="pg-card">
          <h2>Retrieval</h2>
          {!debug ? (
            <p className="muted">Retrieval scores and the threshold decision appear here.</p>
          ) : (
            <>
              <p className={`decision ${debug.decision.refuse ? 'bad' : 'ok'}`}>
                {debug.decision.refuse
                  ? `Refused (${debug.decision.reason})`
                  : 'Passed the gate'}{' '}
                · top {debug.decision.top_score?.toFixed(3) ?? '—'} · threshold{' '}
                {debug.threshold.toFixed(2)}
              </p>
              <table className="doctable">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Score</th>
                    <th>Title</th>
                    <th>Snippet</th>
                  </tr>
                </thead>
                <tbody>
                  {debug.retrieved.map((h, i) => (
                    <tr key={h.id}>
                      <td>{i + 1}</td>
                      <td>{h.score.toFixed(3)}</td>
                      <td className="fname" title={h.title}>
                        {h.title}
                      </td>
                      <td className="muted snip">{h.snippet}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="tuner">
                <h3>Threshold tuner</h3>
                <div className="tuner-row">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={tuned}
                    onChange={(e) => setTuned(Number(e.target.value))}
                  />
                  <span className="tval">{tuned.toFixed(2)}</span>
                </div>
                <p className="muted">
                  At {tuned.toFixed(2)}: top score {topScore?.toFixed(3) ?? '—'} →{' '}
                  <strong>{tunedRefuse ? 'REFUSE' : 'PASS'}</strong>
                </p>
                <button
                  className="ghost"
                  onClick={() => void saveThreshold()}
                  disabled={saving || tuned === threshold}
                >
                  {saving ? 'Saving…' : 'Save threshold'}
                </button>
                {savedMsg && <span className="muted"> {savedMsg}</span>}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
