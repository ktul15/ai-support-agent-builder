# Chat with Your Business — AI Support Agent Builder

A multi-tenant **RAG SaaS**: an SMB uploads its docs/FAQs/policies and gets a mobile AI support assistant that answers customer questions **with cited sources** — and honestly says _"I don't know"_ when the answer isn't in the docs.

> **The money shot:** upload a 30-page PDF, ask a specific question, get a correct cited answer in ~2 seconds — then ask something off-topic and watch it cleanly refuse.

## What it demonstrates

- **RAG done correctly** — structure-aware chunking, tenant-filtered vector retrieval, real citations.
- **Multi-tenancy** — strict per-tenant isolation enforced at the database via Postgres Row-Level Security.
- **AI discipline** — a three-layer guardrail system that makes the assistant refuse off-corpus questions instead of hallucinating.
- **Full-stack range** — Node ingestion pipeline + streaming API + Flutter mobile app + Next.js admin.

## Stack

| Layer                  | Tech                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| Mobile (consumer chat) | Flutter + BLoC + Dio                                               |
| Admin / builder        | Next.js (App Router)                                               |
| API                    | Express (Node/TS) + zod                                            |
| Data                   | Postgres + pgvector (RLS) · Prisma                                 |
| Queue / cache          | Redis + BullMQ                                                     |
| Storage                | Cloudflare R2 / S3                                                 |
| AI                     | Claude (generation) · OpenAI/Voyage (embeddings) · Cohere (rerank) |

## Architecture

```
Flutter app + Next.js admin
          │  HTTPS / SSE
          ▼
   Express API (auth · tenancy · streaming chat · upload)
   │         │            │
 Postgres   Redis      Object store
 +pgvector  queue       (raw files)
 (RLS)        │
              ▼
      Ingestion worker  (parse → chunk → embed → pgvector)
              │
        External AI (embeddings · LLM · reranker)
```

## Local development

Requires Node 20 (`nvm use`) and Docker.

```bash
cp .env.example .env   # fill in required vars
npm install
npm run db:up          # Postgres (pgvector) + Redis via docker compose
npm run dev:api        # http://localhost:3000/health
```

Backing services: `npm run db:up` / `db:down` / `db:reset` (wipe volumes) / `db:logs`.
pgvector is enabled automatically on first DB init (`db/init/001-extensions.sql`).

> Scripts in `db/init/` run **only on a fresh (empty) data volume**. If you edit or
> add init SQL, run `npm run db:reset` to re-apply it (this destroys local data).
> Postgres is published on host port **5433** by default (to avoid clashing with a
> native Postgres on 5432). Need different ports? Set `POSTGRES_PORT` / `REDIS_PORT`
> in `.env` — and update `DATABASE_URL` / `REDIS_URL` to match.

## Status

🚧 In active development. See [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) for the full design, data model, ingestion pipeline, guardrails, and the 4-week build plan.

## License

MIT
