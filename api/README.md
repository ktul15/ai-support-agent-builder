# @asab/api

Express + TypeScript backend: auth, tenant context, document upload, and the
streaming chat endpoint. The ingestion worker (BullMQ) will live alongside it.

Scaffold only today (issue #2) — a `/health` route and the app factory. Real
surface arrives across Phase 1 (foundation/ingestion) and Phase 2 (retrieval/chat).

```bash
npm run dev -w @asab/api        # tsx watch, http://localhost:3000
npm run build -w @asab/api
npm run typecheck -w @asab/api
npm run test -w @asab/api       # vitest
```

`createApp()` (src/app.ts) returns the Express app without binding a port so
tests can exercise routes directly.
