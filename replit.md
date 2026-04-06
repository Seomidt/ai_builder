# BlissOps — AI Ekspert Platform

## Overview

BlissOps er en multi-tenant AI specialist platform. Formålet er at give virksomheder mulighed for at bygge, konfigurere og drive AI eksperter, der opererer ud fra virksomhedens egne data, regler og processer.

**Primær produktenhed: AI Ekspert**
En AI Ekspert er det centrale business-objekt i platformen. Den:
- tilhører en tenant (organisation)
- kan tilhøres en afdeling
- bruger tenant-egne datakilder
- følger definerede regler
- producerer kontrollerede output
- er det primære objekt kunden opretter og administrerer

Alt i tenant-produktet kredser om AI Eksperter.

**Tenant produkt-sektioner (sidebar):**
- AI Chat (primær)
- AI Eksperter
- Storage (Viden & Data)
- Team
- Insights
- Workspace (oversigt/data/AI ops/forbrug/billing/integrationer/indstillinger/audit)

**Navigation:**
- Sidebar (TenantSidebar): Core items + admin items
- TenantNav: Top-navigation brugt INDEN i workspace-sider (stier = `/workspace/*`)
- Routes: `/ai-chat`, `/ai-eksperter`, `/storage`, `/workspace/*`, `/insights`

**Smart model-routing (AI chat):**
- GPT-4.1-nano (trivielt, hilsner) — max 1000 tokens
- GPT-4.1-mini (standard) — max 2000 tokens
- GPT-4.1 (store docs >20k chars, juridisk analyse, multi-spørgsmål) — max 4000 tokens

**Chat streaming:**
- Express registrerer BEGGE paths: `/api/chat/stream` + `/api/chat-stream`
- Frontend kalder `/api/chat-stream` (Vercel-safe flat path)
- Vercel-funktion `api/chat-stream.js` proxyer til Railway's `/api/chat/stream`

## User Preferences

- **Sprog**: Kommuniker på dansk
- **iPhone-bruger**: Kan ikke paste tekst i Replit shell fra iPhone — giv altid korte, trin-for-trin shell-kommandoer der kan skrives manuelt, én ad gangen
- **GitHub**: Remote URL bruger `$GITHUB_PERSONAL_ACCESS_TOKEN` — repo: `github.com/Seomidt/ai_builder`
- **GitHub workflow**: Efter HVERT task (ALTID — ingen undtagelser): 1) push til `feature/ui-surface-domain-routing`, 2) opret PR via GitHub API med dansk beskrivelse, 3) hent PR-nummer og merge automatisk via API. Brugeren skal ALDRIG gøre noget manuelt. Merge sker uden brugerens bekræftelse — bare gør det.

## ⚠️ Infrastruktur-regel (KRITISK)

**Replit er KUN en editor/build-miljø. Al produktion kører på:**
- **Supabase** — eneste database. Brug `SUPABASE_DB_POOL_URL` (med SSL) til direkte SQL eller `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` til REST API. Brug ALDRIG `DATABASE_URL` (Replits lokale Postgres).
- **Vercel** — eneste deploy-platform. Backend kører som serverless functions i `api/_src/*.ts` → kompileres til `api/*.js`. Express-routes i `server/routes.ts` bruges KUN lokalt til dev.
- **OpenAI** — AI-kald via `OPENAI_API_KEY`.
- **Cloudflare** — CDN, DNS, R2 storage.

**DB-migrationer:** Kør ALTID mod Supabase via `SUPABASE_DB_POOL_URL` med `ssl: { rejectUnauthorized: false }`. Aldrig mod `DATABASE_URL`.

## System Architecture

React 19 frontend + Express.js backend. Supabase Postgres med Drizzle ORM.

**UI/UX:**
- Frontend: React 19, Wouter routing
- Styling: Shadcn UI + Tailwind CSS, mørkt navy/teal tema (`#0A0F1C` bg, `#22D3EE` cyan, `#F59E0B` guld)

**Backend & Data:**
- Database: Supabase Postgres (PostgreSQL 17.6) med Drizzle ORM + connection pooler. "No hard delete" — brug `status`-felt.
- Auth: Supabase Auth med JWT middleware (server-side enforcement)
- AI: Abstraheret via `AiProvider` interface. Alle AI-kald køres via `runAiCall()` — central orkestrering, cost tracking og fejlhåndtering.
- Idempotens: Request IDs til duplicate suppression og retry.
- Billing: Wallet/kredit-system, abonnementer, fakturering, immutable ledger.
- Knowledge Base: Multimodalt asset registry (dokumenter, billeder, lyd, video), pgvector semantisk søgning.
- Observability: Fire-and-forget telemetri, AI Operations Assistant.
- Security: RLS på alle tenant-tabeller, Argon2id, TOTP MFA, rate limiting, CSP, Cloudflare WAF.
- RBAC: Tenant-scoped roller, departmenter, permissions — server-side enforcement.

## Core Domain Model

```
architecture_profiles  → AI Eksperter (primær enhed)
specialist_rules       → Regler per ekspert
specialist_sources     → Datakilder linket til ekspert
projects               → Viden & Data (datakilder/dokumenter)
ai_runs                → Kørseler
tenant_departments     → Afdelinger
tenant_member_permissions / tenant_member_departments → RBAC
```

## Implementation Progression

### FOUNDATION
- Multi-tenant isolation, Supabase Auth, JWT middleware
- RBAC: roller, afdelinger, permissions (server-side)
- Database schema med Drizzle ORM

### CORE PRODUCT
- AI Ekspert opret/administrer flow (5-trins wizard)
- "Forbedr med AI" — AI-assisteret ekspertopsætning
- Viden & Data — datakilder og dokumenter linket til eksperter
- Regler — specialist_rules med type-struktur
- Kørseler — kørselspipeline og historik
- Team — afdelings- og permission-administration

### INTELLIGENCE LAYER
- Embedding pipeline (chunking, OCR, pgvector)
- Retrieval orkestrering med token budgeting
- Semantisk søgning over ekspert-data

### CONTROL & GOVERNANCE
- Afdelings-scoped ekspert-adgang (server-side)
- Audit log, security event log
- AI input caps, burst control, injection detection

### LOCALIZATION & EXPERIENCE
- Dansk UI (primær), sprogvalg per ekspert
- Onboarding wizard (5 trin)

### ADVANCED AI CAPABILITIES
- Multi-step ekspert reasoning
- Retrieval-Augmented Generation (RAG) per ekspert
- Multimodal input (billeder, lyd)

### SCALE & MONETIZATION
- Subscription tiers, Stripe billing
- Usage quotas og kreditbaseret model
- White-label tenant branding

## External Dependencies

- **Database:** Supabase Postgres (PostgreSQL 17.6)
- **Authentication:** Supabase Auth
- **AI Providers:** OpenAI (GPT-4o, Responses API, Whisper API)
- **Version Control:** GitHub (via `GITHUB_PERSONAL_ACCESS_TOKEN`)
- **Payment Processing:** Stripe
- **Multimedia:** `ffprobe` + `ffmpeg` (v6.1.2)
- **Edge:** Cloudflare (WAF, rate limiting, SSL, DNS)
- **Deploy:** Vercel (`seomidt-ai_builder`, prj_EBwBBKHXZoCqe2l7eznsojGaSmtV) → blissops.com
- **SSE Streaming:** Dedikerede Vercel serverless functions (`api/chat/stream.js`, `api/ocr-task-stream.js`) proxyer SSE direkte til Railway med `supportsResponseStreaming: true` — bypasser Vercel rewrite + Cloudflare buffering. Alle andre API-kald bruger stadig Vercel rewrite → `api.blissops.com`. Build-scriptet bruger `cjsCompatFooterWithConfig` for SSE-handlers så `config` export bevares.

## AI Expert Edit Flow + Versioning (Phase 2)

### Changes
- **expert_versions** table: id, expert_id, organization_id, version_number, status (draft|live|archived), config_json, created_at, created_by
- **architecture_profiles**: added `draft_version_id` column
- **Model selection removed**: tenants no longer choose provider/model/temperature/tokens — platform-managed only
- **Expert detail page**: `/ai-eksperter/:id` — 6 tabs: Overblik, Instruktioner, Regler, Datakilder, Test, Historik
- **Draft/live versioning**: PATCH writes to draft version, POST /promote sets draft→live, archives old live
- **Test engine**: supports `version: "draft"|"live"` — loads from snapshot, falls back to live fields
- **Prompt builder**: added `buildExpertPromptFromSnapshot()` + `buildVersionSnapshot()` for deterministic snapshot-based prompts
- **Routes added**: POST /promote, POST /unarchive, GET /versions, PUT /rules/:ruleId, upgraded /test

## Productization Pass — Phase 3

### Create Flow Cleanup (Part 2)
- **Slug fjernet fra UI**: genereres server-side (`name` → URL-safe base + `Date.now().toString(36)`)
- **Sprog fjernet fra UI**: hardcoded "da" server-side — aldrig eksponeret som tenant-valg
- **Department conditional**: skjul hvis 0, auto-assign hvis 1, vis dropdown hvis >1
- **AI-suggest**: fjernet `lang` parameter fra Step2 — altid platform-styret
- **Server POST /api/experts**: `CreateArchitectureSchema` gør slug valgfrit

### RAG Wiring (Part 4)
- **Expert test parallel retrieval**: `runRetrieval()` kører parallelt med AI-kald via `Promise.all`
- **Graceful fallback**: `.catch(() => null)` — test virker selvom retrieval er utilgængeligt
- **Test svar**: `retrieved_chunks`, `retrieval_strategy`, `retrieval_latency_ms` returneres
- **UI**: semantisk vs. metadata kildeskelnen, relevance score (%) og "Semantisk" badge

### Content Authenticity (Part 7)
- **`document_risk_scores` tabel oprettet** i DB via direkte SQL
- **Route**: `POST /api/experts/:id/sources/:sourceId/analyze-authenticity`
  - Heuristisk scoring (deterministic, ingen ML-dependency)
  - Signals: `very_short_name`, `not_yet_processed`, `image_source_unverifiable`, `test_or_demo_name`, `ingestion_failed`
  - Gem i `document_risk_scores` (append-only)
- **UI**: ShieldCheck knap pr. kilde i Datakilder-fane → AuthenticityBadge (lav/medium/høj risiko)
- **Produkt-navn**: "Kildeautenticitetssignaler"

### Navigation & Routes (Part 5)
- **TenantSidebar**: tilføjet `Brug & Forbrug` (/brug) og `Indstillinger` (/indstillinger)
- **TenantApp.tsx**: `/brug` → WorkspaceUsage, `/indstillinger` → WorkspaceSettings

### Dansk UX (Part 11)
- `tenant/usage.tsx`: overskrift, periode-knapper, kort-labels → dansk
- `tenant/settings.tsx`: overskrift, gem-knap, sektionsnavne → dansk

## Knowledge Base Storage — Storage 1.2 + 1.3

### Arkitektur
- **Upload pipeline**: multipart → R2 (Cloudflare) → knowledgeStorageObjects → knowledgeDocuments → knowledgeDocumentVersions → knowledgeProcessingJobs
- **Job pipeline pr. filtype**:
  - Dokument (PDF/tekst): `parse → chunk → embedding_generate → index`
  - Billede: `ocr_parse → chunk → embedding_generate → index`
  - Video: `transcript_parse → chunk → embedding_generate → index`

### Worker (Storage 1.3 — Dedikeret process)
- Worker kører **IKKE** automatisk i web-processen
- Start dedikeret: `tsx server/worker.ts`
- Start in-process (Replit/dev): sæt `KB_WORKER=true` env var
- Env vars: `KB_WORKER_POLL_INTERVAL_MS` (default 5000), `KB_WORKER_MAX_CONCURRENT` (default 3)
- Deployment: web = Vercel/Fly web service, worker = Railway/Fly worker service

### OCR (Storage 1.3)
- Provider: OpenAI Vision (gpt-4o-mini via chat completions API)
- Adapter: `server/lib/knowledge/kb-ocr-adapter.ts` — swappable (Tesseract/Azure/Google Vision)
- Understøtter: jpeg, jpg, png, gif, webp

### Embeddings
- Provider: OpenAI text-embedding-3-small (1536 dims)
- Service: `server/lib/knowledge/kb-embeddings.ts`
- Lagring: `knowledge_embeddings.embedding_vector` som `real[]`
- Note: Cosine similarity beregnes application-side. Fremtidig pgvector HNSW-index kræver schema migration til `vector(1536)` type

### Retrieval (Storage 1.3 — Vector-first)
- `server/lib/knowledge/kb-retrieval.ts`
- Rækkefølge: 1) Embed query (OpenAI) → 2) Cosine similarity på stored embeddings → 3) Supplement med pg_trgm hvis færre end topK resultater
- Fallback: lexical-only hvis OpenAI ikke er tilgængelig
- Expert-aware: filtrerer via `expert_knowledge_bases` relation
- Returfelter: `chunkId`, `knowledgeBaseId`, `knowledgeDocumentId`, `assetVersionId`, `chunkText`, `score`, `scoreVector`, `scoreLexical`, `retrievalChannel`

### API
- `POST /api/kb/search` — knowledge søgning (tenant-scoped, expert-aware, topK ≤ 100)
- `GET /api/kb/:id/assets` — returnerer `chunkCount`, `embeddingCount`, `pipeline[]`, `ocrStatus`, `parseStatus`, `transcriptStatus`

## OCR Job Queue & Stale Job Recovery (Phase 4)

### Architecture
- **Job Queue**: Postgres-baseret (ingen external kø-service)
- **Tabel**: `chat_ocr_tasks` med status (pending|running|completed|failed|dead_letter) og stage (ocr|chunking|embedding|storing)
- **Worker**: `api/_src/ocr-worker.ts` på Vercel (serverless function med `maxDuration: 300` + `memory: 1024`)
- **Cron**: `* * * * *` (hver minut) — kværner hvert minut

### Stale Job Recovery
- **`claimJobs()`**: Henter pending jobs, markerer som running, returnerer til worker
- **Stale detection**: Jobs i `running`-status >12 minutter uden `started_at` opdatering → reset til `failed` med `nextRetryAt = NOW() + 2 min`
- **Max attempts**: Job efter 3 fejlede forsøg → `dead_letter` (kræver manuel review)
- **Implementation**: `server/lib/jobs/job-queue.ts` (lokal dev) + re-eksporteret via `api/_src/_lib/ocr-queue.ts` (Vercel)

### UUID Validation
- **Guard i `enqueueOcrJob()`**: Både `tenantId` og `userId` må være gyldige UUIDs (format: `8-4-4-4-12` hex)
- **Fejl hvis slug**: Hvis `tenantId = "blissops-main"` (slug i stedet for UUID) → throws: `"tenantId er ikke et gyldigt UUID: 'blissops-main'. Kontrollér at brugeren har en organisation i databasen."`
- **Formål**: Forhindrer at Postgres `chat_ocr_tasks.tenant_id` (UUID-kolonne) modtager tekstslugger

### Authentication & Tenant Resolution
- **`lookupMembership(userId)`** i `api/_src/_lib/auth.ts`:
  - Opslag: `organization_members` via Supabase REST API
  - Hvis ingen membership-række: forsøger sekundært opslag `organizations?slug=blissops-main` → henter org's rigtige UUID
  - Fallback: returnerer slug hvis begge opsalg fejler (brugeren forbliver logget ind, OCR fejler med præcis UUID-guard-fejl)
  - Logger alle fallback-stier for debugging
- **Server-side mirror** i `server/middleware/auth.ts`:
  - Helper `_resolveOrgSlug()` gør det samme via Drizzle ORM
  - Brugt i platform admin + regular user auth-flow

### Migration
- **File**: `migrations/chat_ocr_tasks_full.sql`
- **Idempotent**: Alle statements har `IF NOT EXISTS` eller `ON CONFLICT DO NOTHING`
- **Indhold**:
  - `chat_ocr_tasks` (25 kolonner) + 4 indekser (inkl. `cot_tenant_hash_uidx` for dedup)
  - `chat_ocr_chunks` (OCR-chunks med foreign key til task)
  - `ocr_cost_log` (prisberegning per job)
- **Kørsel**: Kør i Supabase SQL Editor (sikker på eksisterende skemaer)

### Recent Fixes (Commits)
- `318ee78`: UUID-guard i `enqueueOcrJob()` + slug-to-UUID resolution i auth
- `3f86a67`: `lookupMembership()` returnerer slug-fallback (ikke throw) så auth aldrig logger brugere ud
- `718fcd3`: Blog-siden har hvid indholdsbaggrund + mørk nav-bar (nav designet til mørk bg)

## Frontend Updates

### Blog Page (`client/src/pages/marketing/BlogPage.tsx`)
- **Nav-bar**: Mørk baggrund (`bg-[#030711]`) så `MarketingNav` er læselig
- **Indhold**: Hvid baggrund (`bg-white`) så Soro-embed tekst er læselig
- **Footer**: Hvid baggrund med subtil grå top-border
- **Soro embed**: Farve eksplicit sat til `#111827` (mørkegrå) for kontrastmed hvidt bg
