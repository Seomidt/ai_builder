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

**Tenant produkt-sektioner:**
- Oversigt
- AI Eksperter (primær)
- Viden & Data
- Regler
- Kørseler
- Team
- Workspace

## User Preferences

- **Sprog**: Kommuniker på dansk
- **iPhone-bruger**: Kan ikke paste tekst i Replit shell fra iPhone — giv altid korte, trin-for-trin shell-kommandoer der kan skrives manuelt, én ad gangen
- **GitHub**: Remote URL bruger `$GITHUB_PERSONAL_ACCESS_TOKEN` — repo: `github.com/Seomidt/ai_builder`

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
