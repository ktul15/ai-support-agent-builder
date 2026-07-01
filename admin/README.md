# admin (Next.js builder dashboard)

The SMB-facing builder: signup/login, document upload with live ingestion
progress, the retrieval playground, publish flow, and API-key management.

**Own toolchain** — Next.js 14 (App Router) + TypeScript, intentionally excluded
from the root npm workspaces, the shared ESLint config, and root Prettier. Run
commands from this directory with **Node 20**.

## Commands

- `npm install` — install (has its own `node_modules`).
- `npm run dev` — dev server on **:3001** (the API runs on :3000).
- `npm run build` / `npm run start` — production build / serve.
- `npm run lint` — `next lint`.
- `npm test` — Vitest unit tests for the pure `lib/` logic.

## Auth (issue #29)

Uses a **BFF** so the API JWT is never exposed to browser JS: forms post to Next
Route Handlers under `app/api/auth/*`, which call the Express API server-side and
store the token in an **httpOnly, sameSite=lax** cookie (`asab_session`).
`middleware.ts` gates routes on that cookie — unauthenticated → `/login`,
authenticated on an auth page → `/dashboard`. The API still verifies the JWT on
every data call; the middleware is UX gating, not the security boundary.

Set `API_URL` (see `.env.example`) to point at the Express API.
