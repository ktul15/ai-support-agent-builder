# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Phases 0–2 shipped (merged to `main`).** The backend (`/api` — Express + TS) and `/packages/shared` are implemented and reviewed: multi-tenant Prisma schema with **RLS**, async ingestion (parse → chunk → embed → pgvector) on a **BullMQ** worker, and the full consumer RAG path — tenant-filtered **HNSW** retrieval → threshold gate → numbered prompt assembly → grounded **Claude** generation → **SSE** streaming → mapped citations — plus per-tenant Redis rate limiting and an admin retrieval playground. All six invariants below are enforced in code. **`/admin` (Next.js) and `/mobile` (Flutter) are not yet scaffolded — that is Phase 3.**

`PROJECT_PLAN.md` remains the **source of truth** for architecture, data model, and the phased plan; read it before implementing. See **Backend commands** below for build/lint/test/verify.

## What this is

A multi-tenant **RAG SaaS**: an SMB uploads docs → async ingestion (parse → chunk → embed → pgvector) → a Flutter mobile assistant answers customer questions with **cited sources** and refuses ("I don't know") when the answer is off-corpus. Architecture is multi-tenant from day one; the demo runs one tenant.

## Intended architecture (the big picture)

Monorepo (npm workspaces): `/api` (Express + TS) and `/packages/shared` are built; `/admin` (Next.js) and `/mobile` (Flutter) are stubs pending Phase 3.

Request flow that spans multiple components:

- **Builder path:** `admin` upload → `api` stores raw file in object storage (R2/S3) + enqueues a **BullMQ** job → **ingestion worker** runs the pipeline (parse → structure-aware chunk → dedup → embed) → vectors land in **Postgres/pgvector**. Uploads never block; status flows back as stage events for the live progress UI.
- **Consumer path:** `mobile` question → `api` embeds the query → tenant-filtered **ANN retrieval** → threshold gate → prompt assembly → **Claude** generation → **SSE-streamed** tokens, with a final event carrying `citations[]`.

External AI sits behind narrow swappable interfaces (`Embedder`, `Chat`, `Reranker`) — never call providers directly from feature code; go through these.

## Cross-cutting invariants (do not violate)

These are the reason the project exists; an implementation that breaks one is wrong even if it "works":

1. **Tenant isolation is enforced at the database, not just app code.** Every domain row carries `tenant_id`; Postgres **RLS** policies gate every tenant table. Each request opens a transaction and runs `SET LOCAL app.tenant_id = <jwt.tenant>`. `tenant_id` comes from the verified JWT/API key — **never** from client input. Any new tenant table needs an RLS policy + a test asserting a cross-tenant query returns zero rows.
2. **ANN retrieval filters by `(tenant_id, assistant_id)` before the vector scan** — for both correctness and speed. No vector query without that filter.
3. **The assistant must refuse rather than hallucinate.** Two gates: a pre-LLM **threshold gate** (top similarity score below `assistant.refusal_threshold` → refuse without calling the LLM) and an in-prompt grounding contract (answer only from numbered sources, cite every claim, emit the exact refusal string otherwise). Don't weaken either to make answers "more helpful."
4. **Query and corpus must use the same embedding model.** Changing the embed model means re-embedding the corpus.
5. **SSE streaming on Express:** set `text/event-stream`, `res.flushHeaders()`, `res.write()` per token; **compression middleware must be disabled on the chat route** or buffering defeats streaming. Final event carries `citations[]` + `grounded` + `latency_ms`.
6. **Citations are anchored:** chunks store `page`, `section`, `char_start/char_end` at ingestion time — these power the tappable source view, so preserve them through parsing/chunking.

## Stack

Express + TS (zod validation) · Next.js (App Router) · Flutter + BLoC + Dio · Postgres + pgvector + Prisma · Redis + BullMQ · R2/S3 · Claude (generation) · OpenAI/Voyage (embeddings) · Cohere (rerank, stretch). Chosen to match the owner's existing toolbelt.

When adding code generation in `/mobile`, this machine uses **FVM** — prefer `fvm flutter` / `fvm dart`, and run `fvm dart run build_runner build -d` after editing `@freezed`/`@injectable`/`auto_route` files.

## Backend commands (`/api`)

**Node 20 required.** Run from the repo root unless noted.

- **Build / typecheck:** `npm run build` (tsc project refs across workspaces).
- **Lint / format:** `npm run lint` · `npm run format:check` (write with `npm run format`).
- **Unit tests:** `npm test` (Vitest; no infra needed — pure/domain logic and route rejections).
- **Local infra:** `npm run db:up` (Postgres+pgvector, Redis, MinIO via `docker compose`); `db:reset` wipes volumes.
- **Migrations:** `npm run prisma:deploy -w @asab/api` (applies as the **owner** role via the `migrate.ts` wrapper). Regenerate the client with `npm run prisma:generate -w @asab/api`.
- **Empirical proofs (`verify:*`, need `db:up`):** every DB/infra-touching subsystem has a live proof script — `npm run verify:<name> -w @asab/api` for `rls, tenant, auth, storage, upload, worker, status, retrieval, chat, ratelimit, playground`. **Prefer adding a `verify:*` proof over mocking** when a feature touches the DB/Redis/HTTP.
- **Dev server:** `npm run dev:api`.

**Two DB roles:** migrations run as the **owner**; runtime queries run as the restricted **`asab_app`** role inside `withTenant()` (which sets `app.tenant_id` for RLS). Pre-tenant-context / cross-tenant operations (e.g. auth lookups) go through schema-qualified **SECURITY DEFINER** functions, never the restricted role directly.

## Project management workflow

Work is tracked on **GitHub Projects v2 board #9** (`gh project ... --owner ktul15`), linked to this repo.

- **Phases → milestones**, **subtasks → issues** (#2 onward; follow-ups like #53/#54 added as discovered). Phase labels `phase-0`…`phase-5`; area labels `area:backend|rag|mobile|admin|infra|ai-quality`.
- When starting an issue, move its board item to **In Progress**; reference `#<issue>` in commits/PRs so it links.
- New work items should follow the same pattern: milestone + `phase-N` + `area:*` label + acceptance-criteria checklist, and get added to the board.
- The board's Kanban view groups by the built-in **Status** field.

## Development Workflow (Mandatory)

After completing **every** feature, this 3-step review flow is strictly required before merging. Do not skip any step.

### Step 1 — Developer Explanation

Immediately after finishing a feature, provide a detailed explanation:

- **What was done, why, and how** — describe the feature, its purpose, and the approach taken.
- List **ALL** created/modified files with a one-line purpose for each.
- Explain the **complete data flow** through the system (e.g., UI → Provider → Repository → API/DB and back).
- **Wait for the user to review** before proceeding to Step 2.

### Step 2 — Code Review

After the user has reviewed Step 1:

- Run a **code reviewer agent** to audit all feature code.
- List **ALL** issues found with their respective file names.
- For each issue: explain **what it is**, **why it's a problem**, and give a **real-world example** of the consequence if left unfixed.
- Present the full list to the user and **wait for their decision**.

### Step 3 — Fix Approved Issues

After the user has reviewed Step 2:

- The user decides which issues to fix — **fix only those**.
- Do **NOT** fix issues the user has not approved.
- If fixes are substantial (new files, significant logic changes), **repeat from Step 1** for the fixes.

## Git Workflow (STRICT RULE)

**NEVER work directly on `main` or `dev`. Always create a feature branch.**

- **`main`** — production. Only merged into from `dev`, and only after ALL issues in a phase are completed.
- **`dev`** — integration. Only merged into from feature branches.
- **feature branches** — created from `dev` for every GitHub issue. Format: `feature/issue-<number>-<short-description>`.
- **Flow:** `feature/*` → `dev` → `main`

### Steps for every issue

1. **Move the issue to "In Progress"** on board #9 (`gh issue edit <number> ...` / update the project board Status to "In Progress").
2. `git checkout dev && git pull`
3. `git checkout -b feature/issue-<number>-<short-description>`
4. Do **all** work on the feature branch.
5. **Run code review:** launch a code-reviewer agent to analyze all changes. Present the issues found to the user. Fix **only** the issues the user asks to fix.
6. **Present a review summary** to the user listing:
   - All changes made (files created/modified)
   - Data flow explanation (how data moves through the layers)
   - Key decisions and patterns used
7. **Wait for user approval before committing.** Do NOT commit until the user explicitly clears it.
8. **Pull latest `dev` before merging:** `git checkout dev && git pull && git checkout - && git merge dev`. If there are merge conflicts, resolve them on the feature branch first, verify everything works, then proceed.
9. After approval, **commit and merge the feature branch into `dev` with `--no-ff`**.
10. **Move the issue to "Done":** `gh issue close <number>` and update the project board Status to "Done".
11. **Only after an entire phase is complete, merge `dev` into `main`.**

## Repo conventions

- **Commit identity is repo-local and deliberate:** `Ketul Makwana <ketulm8@gmail.com>` (already set in local git config). Every commit in this repo must use it — don't change it. Remote owner is the `ktul15` GitHub account.
- Commit/push only when explicitly cleared by the user (see Git Workflow step 7).
