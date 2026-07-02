# Chat with Your Business — AI Support Agent Builder

A multi-tenant **RAG SaaS**: an SMB uploads its docs/FAQs/policies and gets a mobile AI support assistant that answers customer questions **with cited sources** — and honestly says _"I don't know"_ when the answer isn't in the docs.

> **The money shot:** upload a PDF, ask a specific question, get a correct cited answer streamed back live — then ask something off-topic and watch it cleanly refuse.

## What it demonstrates

- **RAG done correctly** — structure-aware chunking, tenant-filtered vector retrieval, and **anchored** citations (every source keeps its page/section/char offsets).
- **Multi-tenancy at the database** — strict per-tenant isolation enforced by Postgres Row-Level Security, not trusted to app code. `tenant_id` always comes from the verified JWT.
- **AI discipline** — a two-gate guardrail (a pre-LLM threshold gate + an in-prompt grounding contract) that makes the assistant **refuse** off-corpus questions instead of hallucinating.
- **Measured quality** — a versioned eval set (answer accuracy, citation accuracy, refusal precision/recall) run through the real pipeline.
- **Full-stack range** — Node ingestion pipeline + streaming API + Next.js admin + Flutter mobile app.

## Documentation

- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — components, the two request flows, the multi-tenancy model, the RAG pipeline, the "I don't know" rationale, and the six invariants.
- **[docs/EVAL.md](./docs/EVAL.md)** — how RAG quality is measured (ground-truth set, metrics, reproduction).
- **[PROJECT_PLAN.md](./PROJECT_PLAN.md)** — the full design, data model, and phased plan (source of truth).

## Stack

| Layer | Tech |
| --- | --- |
| Mobile (consumer chat) | Flutter + BLoC + Dio |
| Admin / builder | Next.js (App Router) |
| API + worker | Express (Node/TS) + zod · BullMQ |
| Data | Postgres + pgvector (RLS) · Prisma |
| Queue / cache | Redis + BullMQ |
| Storage | Cloudflare R2 / S3 |
| AI | Claude (generation) · OpenAI (embeddings) · Cohere (rerank, stretch) |

## Architecture at a glance

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
        External AI (embeddings · LLM)
```

Full diagram and request-flow walkthroughs in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Repository layout

```
api/        Express API + ingestion worker + eval harness (npm workspace)
admin/      Next.js builder UI (own toolchain)
mobile/     Flutter consumer app (own toolchain, FVM-pinned)
packages/   shared provider interfaces + types
db/         Postgres init (pgvector) for local docker
docs/       ARCHITECTURE.md · EVAL.md
```

## Local development

Requires **Node 20** (`nvm use`) and Docker; the mobile app uses **Flutter via FVM**.

### API + worker

```bash
cp .env.example .env   # fill in required vars (DB, Redis, provider keys)
npm install
npm run db:up          # Postgres (pgvector) + Redis + MinIO via docker compose
npm run prisma:deploy -w @asab/api   # apply migrations (as the owner role)
npm run dev:api        # http://localhost:3000/health
```

`npm run db:up` / `db:down` / `db:reset` (wipe volumes) manage backing services. pgvector is enabled on first DB init.

### Admin (Next.js)

```bash
cd admin && npm install && npm run dev   # http://localhost:3001
```

### Mobile (Flutter)

```bash
cd mobile
fvm flutter pub get
fvm dart run build_runner build --delete-conflicting-outputs
fvm flutter run --target lib/main_dev.dart \
  --dart-define=API_BASE_URL=http://10.0.2.2:3000 --dart-define=API_KEY=<key>
```

See [`mobile/README.md`](./mobile/README.md) for flavors and the iOS-simulator base URL.

## Verifying

The codebase favors **live proof scripts** over mocks for anything touching the DB/Redis/HTTP. With infra up (`npm run db:up`):

```bash
npm test                          # unit/domain tests (no infra needed)
npm run verify:rls -w @asab/api   # e.g. cross-tenant query returns zero rows
# also: verify:tenant|auth|storage|upload|worker|status|retrieval|chat|ratelimit|playground|observability
npm run eval -w @asab/api         # RAG eval harness (needs provider keys) — see docs/EVAL.md
```

## Status

Backend, admin, and mobile are implemented and reviewed (Phases 0–3); Phase 4
adds evals, observability, deploy, and demo polish. See
[`PROJECT_PLAN.md`](./PROJECT_PLAN.md) for the phased plan.

## License

MIT
