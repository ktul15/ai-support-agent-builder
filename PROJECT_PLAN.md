# Chat with Your Business — AI Support Agent Builder

**Project type:** Flagship portfolio project · Multi-tenant RAG SaaS
**Build estimate:** 3–4 weeks (MVP), architecture ready to scale
**One-line pitch:** An SMB uploads its docs/FAQs/policies and instantly gets a mobile AI support assistant that answers customer questions with cited sources — and honestly says "I don't know" when the answer isn't in the docs.

---

## 0. Why this project (portfolio thesis)

This is the single most-requested AI capability in the market right now. Shipping it cleanly proves four things employers and clients actually pay for:

1. **RAG done correctly** — not a toy. Real chunking, real retrieval quality, real citations.
2. **Multi-tenancy** — strict per-tenant data isolation, the hard part of any B2B SaaS.
3. **AI discipline** — the model refuses to hallucinate. "I don't know" is a feature, not a bug.
4. **Full-stack range** — Node ingestion pipeline + streaming API + Flutter mobile app + web admin.

The portfolio money shot: *upload a 30-page PDF, ask a specific question, get a correct cited answer in ~2 seconds, then ask something off-topic and watch it cleanly refuse.*

---

## 1. Scope

### MVP (must ship)
- Web **builder/admin** dashboard: tenant signs up, uploads docs (PDF/MD/TXT/DOCX), watches ingestion status.
- **Ingestion pipeline**: parse → chunk → embed → store in pgvector, with progress + error states.
- **Mobile assistant** (Flutter): streaming chat that answers from the tenant's corpus with inline citations.
- **Citations**: every answer links back to source doc + page/section; tappable to view the snippet.
- **"I don't know" fallback**: off-corpus questions get an honest refusal, not a hallucination.
- **One live tenant** for the demo; schema + code multi-tenant from day one.
- **Auth**: tenant owner login (admin) + scoped access for the assistant.

### Stretch (post-MVP, shows roadmap thinking)
- Embeddable **web chat widget** (the upsell in the brief).
- **Usage analytics**: top questions, unanswered questions, deflection rate.
- **Hybrid search** (vector + keyword/BM25) and a **reranker**.
- **Conversation memory** (multi-turn follow-ups with context).
- **Feedback loop**: thumbs up/down → eval dataset → quality tracking.
- **Self-serve billing** (Stripe), usage tiers.

### Explicit non-goals (MVP)
- No fine-tuning. RAG only.
- No voice. Text chat only.
- No human-handoff / live-agent escalation (note it as a roadmap item).
- No on-prem / VPC deployment.

---

## 2. Users & core flows

| Persona | Goal | Surface |
|---|---|---|
| **SMB owner** (the buyer) | Upload docs, get a working assistant, see it works | Web admin |
| **Customer / end user** | Ask a question, get a trustworthy cited answer | Flutter app (or widget) |
| **You / operator** | Monitor ingestion, evals, cost | Admin + dashboards |

**Builder flow:** sign up → create assistant → upload docs → watch ingest → test in playground → publish.
**Consumer flow:** open app → ask question → streamed answer with citations → tap citation to verify → if off-corpus, get "not in the docs" refusal.

---

## 3. System architecture

```
┌─────────────────┐     ┌──────────────────┐
│  Flutter app    │     │  Next.js admin   │
│ (consumer chat) │     │  (SMB builder)   │
└────────┬────────┘     └────────┬─────────┘
         │  HTTPS / SSE          │  HTTPS
         └───────────┬───────────┘
                     ▼
          ┌─────────────────────┐
          │   Express API (Node)│
          │  - auth / tenancy   │
          │  - chat (streaming) │
          │  - upload / ingest  │
          └──┬───────┬───────┬──┘
             │       │       │
   ┌─────────▼─┐ ┌───▼────┐ ┌▼─────────────┐
   │ Postgres  │ │ Redis  │ │ Object store │
   │ +pgvector │ │ queue+ │ │ (S3/R2)      │
   │ (RLS)     │ │ cache  │ │ raw files    │
   └───────────┘ └───┬────┘ └──────────────┘
                     │
            ┌────────▼─────────┐
            │ Ingestion worker │  (BullMQ consumer)
            │ parse→chunk→embed│
            └────────┬─────────┘
                     ▼
        External AI: Embeddings + LLM + Reranker
        (Anthropic Claude · OpenAI/Voyage embeds · Cohere rerank)
```

**Design principle:** the API stays thin and fast; heavy ingestion runs async in a worker so uploads never block. Chat is synchronous + streamed.

---

## 4. Tech stack (and why)

Chosen to match your existing toolbelt (Express + Next.js + Prisma + Postgres + Redis; Flutter + BLoC from your apps) so it's realistic and fast to build.

| Layer | Choice | Why |
|---|---|---|
| Mobile | **Flutter + BLoC + Dio** | Your strongest stack; SSE streaming via Dio/`http` |
| Admin web | **Next.js (App Router)** | Already in your toolkit; great for upload UI + dashboards |
| API | **Express (Node/TS)** | Ubiquitous, huge ecosystem; SSE streaming via raw `res.write`; pair with `zod` for request validation |
| DB | **Postgres + pgvector** | Brief mandates pgvector; single DB for relational + vectors |
| ORM | **Prisma** | You use it; `Unsupported("vector")` + raw SQL for ANN queries |
| Queue/cache | **Redis + BullMQ** | Async ingestion jobs, rate limiting, response cache |
| Object storage | **Cloudflare R2 / S3** | Raw file storage, per-tenant prefixes |
| LLM | **Claude (Haiku 4.5 default, Sonnet 4.6 for quality)** | Strong grounding + cheap streaming; fits your ecosystem |
| Embeddings | **OpenAI `text-embedding-3-small` (1536-d)** default; Voyage `voyage-3` as quality option | Cheap, solid retrieval; swappable behind an interface |
| Reranker (stretch) | **Cohere `rerank-3.5`** | Big precision win on top-k |
| Parsing | `pdf-parse`/`unpdf`, `mammoth` (DOCX), `marked` (MD) | Reliable text extraction per format |
| Infra | Railway/Render/Fly for API+worker; Neon/Supabase for PG | Fast deploy, pgvector supported |

**Abstraction rule:** wrap embeddings, LLM, and reranker behind narrow TS interfaces (`Embedder`, `Chat`, `Reranker`) so any provider is swappable — this itself is a portfolio signal.

---

## 5. Data model (multi-tenant core)

Every domain row carries `tenant_id`. Postgres **Row-Level Security (RLS)** enforces isolation at the database, not just app, layer — the strongest demonstrable tenancy story.

```sql
-- tenants (the SMBs)
tenant(id, name, plan, created_at)

-- users who can administer a tenant
app_user(id, tenant_id, email, password_hash, role)   -- role: owner|member

-- an assistant = a published corpus + config
assistant(id, tenant_id, name, system_prompt, model,
          refusal_threshold, status)   -- status: draft|published

-- uploaded source files
document(id, tenant_id, assistant_id, title, source_type,
         storage_key, page_count, status, error, created_at)
         -- status: uploaded|parsing|embedding|ready|failed

-- the retrievable units
chunk(id, tenant_id, document_id, assistant_id,
      content, token_count,
      page, section, char_start, char_end,   -- citation anchors
      embedding vector(1536),
      content_hash)                            -- dedup

-- conversations (consumer side)
conversation(id, tenant_id, assistant_id, end_user_ref, created_at)
message(id, conversation_id, tenant_id, role, content,
        citations jsonb, latency_ms, tokens, grounded bool)

-- per-tenant API keys for the mobile app / widget
api_key(id, tenant_id, assistant_id, key_hash, last_used_at)
```

**Indexes:**
- `chunk` HNSW index on `embedding` (`vector_cosine_ops`), `m=16, ef_construction=64`.
- Composite `(tenant_id, assistant_id)` on `chunk` so ANN queries filter tenant **before** the vector scan.
- `content_hash` unique per `(tenant_id, assistant_id)` to skip re-embedding identical chunks.

**RLS sketch:**
```sql
ALTER TABLE chunk ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chunk
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```
The API sets `SET LOCAL app.tenant_id = '<jwt.tenant>'` at the start of every request transaction. Even a query bug can't leak across tenants.

---

## 6. Ingestion pipeline (the unglamorous part that decides quality)

Triggered on upload; runs in the BullMQ worker. Stages, each idempotent and resumable:

1. **Store** raw file → R2 at `tenants/{tenant_id}/{doc_id}/original`.
2. **Parse** by type → normalized text + structure (headings, page boundaries). Keep page numbers — they power citations.
3. **Clean** — strip boilerplate, normalize whitespace, drop empty pages.
4. **Chunk** — structure-aware recursive splitting:
   - Target **~500–800 tokens** per chunk, **~100-token overlap**.
   - Prefer breaking on headings/paragraphs, never mid-sentence.
   - Attach metadata: `document_id, page, section, char_start, char_end`.
   - Prepend a small **context header** to each chunk (doc title + section path) so embeddings carry document context ("contextual retrieval" pattern).
5. **Dedup** — `content_hash` skip; saves embedding cost on repeated boilerplate.
6. **Embed** — batch chunks (e.g. 96/call) through the `Embedder`; store vectors.
7. **Finalize** — mark document `ready`, update assistant chunk count, emit progress event.

**Progress UX:** worker emits status per stage → admin shows a live progress bar (`uploaded → parsing → embedding → ready`). Failures surface a readable error + retry button.

**Why these numbers:** 500–800 tokens balances retrieval precision (small enough to be specific) against context (large enough to be self-contained); overlap prevents answers being split across a chunk boundary; the context header measurably lifts retrieval accuracy at near-zero cost.

---

## 7. Retrieval + prompt assembly

On each question:

1. **Embed the query** with the same model as the corpus.
2. **ANN search** in pgvector — cosine distance, top-`k` (k≈20), **always filtered by `(tenant_id, assistant_id)`**.
   ```sql
   SELECT id, content, page, section, document_id,
          1 - (embedding <=> $query) AS score
   FROM chunk
   WHERE tenant_id = $t AND assistant_id = $a
   ORDER BY embedding <=> $query
   LIMIT 20;
   ```
3. **(Stretch) Hybrid** — union with a `tsvector` keyword search, then **rerank** top-20 → top-5 with Cohere. Big precision gain for exact-term questions (SKUs, policy names).
4. **Threshold gate** — if the best score < `refusal_threshold`, **short-circuit to "I don't know"** before calling the LLM. Saves tokens and guarantees the refusal on truly off-corpus questions.
5. **Assemble prompt** — top-5 chunks, each tagged with a citation id:
   ```
   [1] (Refund Policy, p.4) <chunk text>
   [2] (Shipping FAQ, p.1) <chunk text>
   ...
   ```
6. **System prompt** (grounding contract):
   > You are {assistant} for {tenant}. Answer ONLY from the numbered sources below.
   > Cite every claim with [n]. If the sources don't contain the answer, say exactly:
   > "I don't have that in the docs I was given." Never use outside knowledge. Never guess.

7. **Generate** with Claude, **streamed** to the client.

---

## 8. Citations

- Model is instructed to emit inline markers `[1]`, `[2]`.
- Response payload includes a `citations[]` array mapping each marker → `{document_id, title, page, section, snippet, char_start, char_end}`.
- Mobile UI renders markers as tappable chips → bottom sheet showing the exact source snippet + "Open document."
- This closes the trust loop: the user can **verify** the answer, which is the whole selling point.

---

## 9. Guardrails / the "I don't know" discipline

Three layers, defense in depth:

1. **Retrieval gate** (pre-LLM): score below threshold → refuse without generating. Cheapest, catches clear off-corpus.
2. **Prompt contract** (in-LLM): explicit refusal instruction + citation requirement.
3. **Groundedness check** (post-LLM, stretch): a cheap Haiku pass — "is every claim supported by the cited sources? yes/no" — flips ungrounded answers to a refusal and logs them. This is the eval signal for quality.

Also: **PII/abuse input filter**, **per-tenant rate limiting** (Redis token bucket), **max context budget** so prompts can't blow up cost. Tune `refusal_threshold` per assistant from the playground.

---

## 10. Streaming chat

- **Server:** Express SSE — set `Content-Type: text/event-stream`, `res.flushHeaders()`, then `res.write()` each token chunk; send a final event carrying `citations[]` + `grounded` + `latency_ms`. (Disable compression middleware on this route so chunks flush immediately.)
- **Client (Flutter):** consume the byte stream via Dio `ResponseType.stream`, append tokens to a `BlocBuilder` chat state; render citations on the final event.
- **Resilience:** heartbeat pings, cancel on user leave, graceful fallback to non-streamed if SSE drops.
- **Perceived latency** is the demo — first token in well under a second sells the product.

---

## 11. Multi-tenancy & security

- **DB-level RLS** (Section 5) — the headline isolation story.
- **App-level**: tenant_id derived from JWT, never from client input; `SET LOCAL app.tenant_id` per request.
- **Storage**: per-tenant R2 prefixes; signed URLs only.
- **API keys** for the mobile app/widget are scoped to one `assistant_id`; hashed at rest.
- **Tenant-aware rate limits + usage metering** in Redis (also the billing substrate).
- **Secrets** in env/secret manager; no provider keys on the client — all AI calls go through your API.

---

## 12. API surface (sketch)

```
# Admin (JWT)
POST   /v1/auth/signup | /login
POST   /v1/assistants
POST   /v1/assistants/:id/documents      (multipart → enqueue ingest)
GET    /v1/assistants/:id/documents      (status list)
GET    /v1/documents/:id                  (progress/errors)
POST   /v1/assistants/:id/publish
POST   /v1/assistants/:id/playground      (test query, returns retrieval debug)

# Consumer (API key scoped to assistant)
POST   /v1/chat                           (SSE stream: tokens + citations)
GET    /v1/conversations/:id              (history)
POST   /v1/messages/:id/feedback          (thumbs, stretch)
```

Playground returns **retrieval debug** (which chunks, scores, threshold decision) — invaluable for demos and tuning.

---

## 13. Mobile app (Flutter)

- **Architecture:** BLoC + Dio + (optional) auto_route, matching your joinbeet pattern.
- **Screens:** assistant home / chat, message list with streamed bubbles, citation bottom-sheet, "powered by" + refusal states.
- **State:** `ChatBloc` (idle/streaming/done/error), `CitationCubit`.
- **Polish that sells:** typing indicator, token-by-token reveal, citation chips, a clean refusal card (distinct visual so the honesty reads as a feature).

---

## 14. Observability & evals (the maturity signal)

- **Structured logs** per request: tenant, latency, tokens, top scores, grounded flag, refusal reason.
- **Eval set:** ~30 Q&A pairs over the demo corpus + ~10 known off-corpus questions. Track **answer accuracy**, **citation correctness**, **refusal precision/recall**.
- **Cost dashboard:** tokens + embeddings per tenant.
- **"Unanswered questions" log** → product feedback loop (and a sales story: "here's what your customers ask that your docs don't cover").

---

## 15. Cost model (rough, MVP scale)

- **Ingestion:** `text-embedding-3-small` ≈ $0.02 / 1M tokens → a 30-page PDF (~20k tokens) costs ~$0.0004 to embed. Negligible.
- **Chat:** Claude Haiku streaming, ~2k context + short answer → fractions of a cent per message; Sonnet for quality tiers.
- **Takeaway:** RAG is cheap; the value is in correctness + isolation, not compute. Monetize on seats/usage, not cost-plus.

---

## 16. Monetization (roadmap slide)

- **Per-tenant subscription** (base assistant + N docs).
- **Usage tiers** (messages/month, doc count, model quality Haiku→Sonnet).
- **Embed/web widget** as the upsell (brief calls this out).
- **Agency plan:** white-label, manage many client tenants — leans directly on the multi-tenant architecture.

---

## 17. Build plan (4 weeks)

**Week 1 — Foundation & ingestion**
- Repo, env, Docker Postgres+pgvector+Redis, Prisma schema + RLS, R2 bucket.
- Express skeleton, auth (signup/login/JWT), tenant middleware.
- Upload endpoint + BullMQ worker; parse + chunk + embed PDF end-to-end.
- *Milestone:* upload a PDF, see chunks with embeddings land in pgvector, status → ready.

**Week 2 — Retrieval, chat, guardrails**
- ANN query (tenant-filtered), prompt assembly, Claude integration.
- SSE streaming endpoint; citations payload.
- Threshold gate + refusal contract; playground endpoint with retrieval debug.
- *Milestone:* curl a question → streamed cited answer; off-corpus → clean refusal.

**Week 3 — Surfaces**
- Next.js admin: upload UI w/ live progress, document list, playground, publish.
- Flutter app: ChatBloc + streaming bubbles + citation bottom-sheet + refusal card.
- API-key auth for consumer chat.
- *Milestone:* full demo loop works on device.

**Week 4 — Polish, evals, demo**
- Eval set + metrics; tune chunking + threshold.
- (Stretch) hybrid + reranker, groundedness check, feedback thumbs.
- Seed a real demo corpus; record the killer-demo video; write README + architecture doc.
- Deploy API+worker+DB; ship.
- *Milestone:* portfolio-ready, deployed, recorded.

---

## 18. Killer-demo script

1. Upload a real 30-page PDF (e.g. a product manual or returns policy). Show the live ingest bar → ready.
2. Ask a **specific** question ("What's the warranty period for X?"). First token in <1s, answer streams with `[1]` citation.
3. **Tap the citation** → bottom sheet shows the exact paragraph + page. Trust loop closed.
4. Ask something **off-corpus** ("Do you ship to Mars?") → clean "I don't have that in the docs" refusal, visually distinct.
5. (Closer) open the playground → show retrieval scores + the threshold decision behind the refusal. *That's the engineering credibility shot.*

---

## 19. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Bad PDF parsing (tables, scans) | Per-format parsers; flag low-text pages; OCR as roadmap |
| Retrieval misses (poor chunking) | Context headers, overlap, hybrid+rerank, eval set to tune |
| Hallucination slips through | 3-layer guardrails + groundedness check + eval on refusal recall |
| Tenant data leak | DB-level RLS + tenant-filtered ANN + tests asserting cross-tenant queries return zero |
| Streaming flakiness | Heartbeats, cancel, non-stream fallback |
| Cost surprises | Token budgets, rate limits, per-tenant metering |

---

## 20. What to write up for the portfolio

- **Architecture diagram** + a paragraph on the multi-tenancy decision (RLS).
- **The chunking/retrieval rationale** — shows you understand RAG, not just glued an API.
- **The "I don't know" section** — frame AI honesty as deliberate engineering.
- **The demo video** — the upload→cite→refuse loop, 60 seconds.
- **Eval numbers** — refusal precision/recall + answer accuracy. Few portfolios show evals; this one does.

---

### TL;DR
Thin streaming Express API · async BullMQ ingestion into pgvector · tenant-filtered retrieval behind DB-level RLS · Claude generation with a hard grounding contract and a pre-LLM refusal gate · Flutter consumer app + Next.js builder. Demo proves correct cited answers in seconds and disciplined refusals on off-corpus questions. Swappable provider interfaces and an eval harness signal maturity beyond a prototype.
