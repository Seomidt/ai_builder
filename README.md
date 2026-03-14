# AI Builder Platform

Enterprise multi-tenant AI SaaS backend platform providing AI runtime orchestration, usage metering, a complete billing engine, wallet ledger, subscription plans, Stripe payments, automated billing operations, a billing integrity and recovery system, and a full-stack knowledge retrieval pipeline — including document versioning, async processing pipelines, vector embeddings, pgvector similarity search, full-text search (FTS), Reciprocal Rank Fusion (RRF) hybrid retrieval, deterministic reranking, and multi-layer retrieval provenance and explainability.

---

## 1. Project Overview

This repository implements the control plane for an AI-driven software generation platform. It is designed for production operation at scale:

- 1 000+ tenants
- 50 000+ users
- Millions of AI requests per billing period

The platform separates concerns cleanly across an AI runtime pipeline, a multi-layer billing engine, a wallet credit system, a subscription entitlement layer, a Stripe payment integration, an automated operations layer with integrity scanning and recovery workflows, and a production-grade knowledge retrieval pipeline with hybrid search, vector + lexical fusion, deterministic reranking, and full retrieval explainability.

---

## 2. System Architecture

```
Client / Tenant App
        │
        ▼
  Express API Server (server/)
        │
   ┌────┴──────────────────────────────────────────┐
   │              Admin API Routes                 │
   │   /api/admin/* — internal operations only     │
   └──────────────────────┬────────────────────────┘
                          │
   ┌──────────────────────┼───────────────────────┐
   │                      │                       │
   ▼                      ▼                       ▼
AI Runtime           Billing Engine         Billing Operations
(lib/ai/runner.ts)   (lib/ai/billing-*)     (lib/ai/billing-jobs*)
   │                      │                       │
   │               ┌──────┴──────────┐            │
   │               │                 │            │
   ▼               ▼                 ▼            ▼
ai_usage     ai_billing_usage   invoices    billing_job_runs
             wallet ledger      payments    recovery_runs
             snapshots          stripe sync actions
```

All persistent state lives in Supabase Postgres accessed through Drizzle ORM. There is no in-process billing state. Every financial mutation is written to the database before being considered applied.

---

## 3. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express 5 |
| Frontend | React 19 + Vite (Wouter routing, TanStack Query v5, Shadcn UI, Tailwind CSS) |
| ORM | Drizzle ORM |
| Database | Supabase Postgres (PostgreSQL 17.6) via connection pooler |
| Auth | Supabase Auth (JWT middleware) |
| AI Providers | OpenAI (Responses API) — provider-abstracted |
| Payments | Stripe |
| Schema validation | Zod + drizzle-zod |
| GitHub integration | PAT-based, commit / branch / PR utilities |

---

## 4. Multi-Tenant Design

Every data-bearing table carries a `tenant_id` column. Tenant isolation is enforced at the application layer: all queries filter by `tenant_id` before returning results.

Key isolation guarantees:

- `ai_usage` — per-tenant AI call records, unique constraint on `(tenant_id, request_id)` where `request_id IS NOT NULL`
- `ai_billing_usage` — one billing row per usage row, scoped to tenant
- `tenant_credit_ledger` — append-only wallet per tenant, no cross-tenant reads
- `billing_period_tenant_snapshots` — unique per `(billing_period_id, tenant_id)` pair
- All subscription, invoice, payment, and allowance tables carry `tenant_id`

There are no shared financial aggregates across tenants. Every financial rollup is computed and stored per tenant.

Tenant identification is via `x-organization-id` request header. In production, the organization is resolved from the Supabase JWT.

---

## 5. AI Runtime Pipeline

Every AI call made by any tenant follows this sequence:

```
1.  Tenant request arrives
2.  AI Runtime resolves model route (code default → DB override → tenant override)
3.  Idempotency check (in-process Set + ai_request_states)
4.  Request safety checks (token cap, rate limit, concurrency guard)
5.  Budget / usage guard (blocked state, budget mode)
6.  Response cache lookup (SHA-256 fingerprint, TTL 3600s)
7.  Step budget acquire (max 5 AI calls per request_id)
8.  Provider call (OpenAI Responses API)
9.  ai_usage row inserted:
      tenant_id, feature, provider, model,
      prompt_tokens, completion_tokens, total_tokens,
      estimated_cost_usd, pricing_source, pricing_version,
      cached_input_tokens, reasoning_tokens
10. Billing engine triggered:
      ai_billing_usage row inserted with customer_price_usd,
      provider_cost_usd, margin_usd, pricing_mode
11. Wallet debit applied:
      tenant_credit_ledger row inserted (append-only)
      wallet_status on ai_billing_usage set to 'debited'
12. Entitlement classification recorded:
      entitlement_treatment, included_amount_usd, overage_amount_usd
```

`ai_usage` is the canonical source of raw provider interactions. `ai_billing_usage` is the canonical source of billing truth. These two tables are never merged or mutated after creation (with the exception of the three wallet delivery fields on `ai_billing_usage`).

---

## 6. Monetization Engine

The monetization engine spans Phases 4A through 4S.

### 6.1 Billing Calculations

Pricing is resolved in a layered hierarchy:

```
tenant-specific customer pricing config
         ↓
global customer pricing config
         ↓
code default pricing
```

Three pricing modes are supported: `cost_plus_multiplier`, `fixed_markup`, `per_1k_tokens`.

Provider cost is always recorded from the resolved `ai_model_pricing` row or code defaults. Customer price is computed independently. The margin is `customer_price_usd - provider_cost_usd`.

### 6.2 Pricing Versions

All pricing changes are versioned:

- `provider_pricing_versions` — provider cost per model, effective date range
- `customer_pricing_versions` — customer price per tenant / feature / provider, effective date range

Both `ai_billing_usage` and `storage_billing_usage` store the resolved pricing version IDs at time of billing. This enables historical reconstruction of any billing record.

### 6.3 Billing Periods

`billing_periods` records the calendar boundary of each billing cycle. Status lifecycle: `open → closing → closed`.

Closing a billing period:
1. Marks the period as `closing`
2. Aggregates all `ai_billing_usage` and `storage_billing_usage` rows into `billing_period_tenant_snapshots`
3. Marks the period as `closed`

Closed periods are immutable. Snapshots for closed periods are never modified outside explicit recovery workflows.

Note: `ai_billing_usage` has no `billing_period_id` foreign key. Period attribution is computed via a date-range join on `billing_periods.period_start / period_end`.

### 6.4 Storage Billing

Storage usage is metered through `storage_usage` (raw measurements) and `storage_billing_usage` (billing records). Metric types: `gb_stored`, `gb_egress`, `class_a_ops`, `class_b_ops`. Storage billing totals are included in `billing_period_tenant_snapshots`.

### 6.5 Anomaly Detection

`billing_anomaly_runs` records each anomaly scan pass. Detectors scan for: usage spikes relative to tenant rolling baseline, zero-cost successful calls, margin violations, and token-to-cost ratio anomalies. Anomalies are surfaced for human review. No automatic remediation.

### 6.6 Margin Tracking

`billing_margin_snapshots` records computed margin at global, provider, and tenant scope. Used for operational margin dashboards and trend detection.

### 6.7 Provider Reconciliation

`provider_reconciliation_runs` and `provider_reconciliation_findings` track discrepancies between platform-recorded usage and provider-reported usage. Findings are classified by severity and require manual resolution.

---

## 7. Wallet Ledger

The wallet is an append-only credit ledger per tenant.

```
tenant_credit_ledger
  └── entry_type: credit | debit | adjustment | refund
  └── amount_usd (positive = credit, negative = debit)
  └── reference_id → ai_billing_usage.id or invoice_payment.id
  └── balance_after (running balance maintained at insert time)
```

Design rules:
- No row is ever updated or deleted
- Every debit is linked to a specific `ai_billing_usage` row
- Wallet status on `ai_billing_usage` tracks debit confirmation: `pending → debited | failed`
- Failed debits are replayable via `billing_usage_id`

---

## 8. Subscription System

### 8.1 Plans and Entitlements

`subscription_plans` defines commercial tiers. Each plan has `plan_entitlements` rows defining:
- `entitlement_type`: `ai_allowance_usd`, `storage_allowance_gb`, `feature_flag`, `rate_limit`, `seat_limit`
- Allowance amounts for the billing period

`tenant_subscriptions` links a tenant to a plan with a lifecycle: `active → cancelled | expired`.

### 8.2 Allowance Accounting

At billing time, each `ai_billing_usage` row is classified against the tenant's active plan allowance:

- `entitlement_treatment`: `standard | included | partial_included | overage | blocked`
- `included_amount_usd`: portion covered by the plan
- `overage_amount_usd`: portion billed as overage

Allowance consumption is recorded in:
- `tenant_ai_allowance_usage` — one row per `ai_billing_usage` (unique constraint)
- `tenant_storage_allowance_usage` — one row per `storage_billing_usage` (unique constraint)

Both allowance tables are immutable after insert.

---

## 9. Invoice & Payment System

### 9.1 Invoices

`invoices` has a status lifecycle: `draft → finalized → void`.

`invoice_line_items` records summary lines per invoice. Line types: `ai_usage_summary`, `wallet_debit_summary`, `margin_summary`, `storage_usage`, `adjustment`.

Rules:
- Finalized invoices are never mutated by application code
- `subtotal_usd` must equal the sum of `line_total_usd` across line items
- One invoice per `(tenant_id, billing_period_id)` — enforced by unique index

### 9.2 Payments

`invoice_payments` tracks payment attempts per invoice. Status lifecycle: `pending → processing → paid | failed | refunded | void`.

`stripe_invoice_links` holds the mapping between internal invoice IDs and Stripe invoice IDs. `stripe_webhook_events` records every inbound Stripe webhook for idempotent processing.

### 9.3 Stripe Integration

The Stripe integration layer handles:
- Checkout session creation for initial subscription
- Subscription sync from Stripe to platform subscription tables
- Webhook event ingestion and idempotent processing
- Payment confirmation and reconciliation

---

## 10. Automated Billing Operations (Phase 4R)

The automated operations layer provides a durable, scheduled execution system for recurring billing maintenance jobs.

### 10.1 Tables

| Table | Purpose |
|---|---|
| `billing_job_definitions` | Job catalog with schedule, singleton mode, retry config, priority, duration warning |
| `billing_job_runs` | Execution audit trail — one row per invocation |

### 10.2 Job Definitions

13 predefined jobs are seeded on startup via `ensureBillingJobDefinitions()`. Jobs are idempotent — safe to re-run. Categories: `snapshot`, `monitoring`, `anomaly`, `reconciliation`, `audit`, `payment`, `maintenance`.

**Phase 4R jobs (10):** global billing metrics snapshot, tenant billing metrics snapshot, billing period metrics snapshot, billing anomaly scan, provider reconciliation scan, billing audit scan, margin tracking scan, pending payment health scan, stale webhook health scan, stale admin change health scan.

**Phase 4S jobs (3):** billing integrity scan, snapshot rebuild health scan, repeated recovery failure scan. All three are scan-and-detect only — they never auto-repair.

### 10.3 Execution Model

```
runBillingJob(jobKey, options)
  1. Check distributed lock (pg_try_advisory_xact_lock + started-row guard)
  2. Create billing_job_runs row (status: started)
  3. Execute registered job executor function
  4. Update run row (status: completed | failed | timed_out | skipped)
```

Singleton enforcement uses two layers:
- **Layer 1:** `pg_try_advisory_xact_lock` — prevents concurrent execution
- **Layer 2:** started-row check — prevents self-blocking across transactions

The lock check happens before the run row is created. This prevents a job from blocking itself on retry.

### 10.4 Scheduler

`billing-scheduler.ts` provides an interval-based trigger. It checks which interval jobs are due (based on `schedule_expression` in seconds and the most recent completed run timestamp) and calls `runBillingJob` for each due job. Only `interval` jobs are auto-triggered; `manual` and `cron` jobs require explicit invocation.

### 10.5 Priority and Duration Monitoring (Phase 4S hardening)

- `billing_job_definitions.priority` (integer 1–10, default 5, lower = higher priority) — records intended scheduling priority for future priority-based queuing
- `billing_job_definitions.job_duration_warning_ms` (nullable integer) — slow-run warning threshold per job
- `billing_job_runs.worker_id` (nullable text) — identifies the executing worker node for distributed debugging

---

## 11. Billing Integrity & Recovery (Phase 4S)

The integrity and recovery layer provides read-only scan capabilities and controlled write-recovery workflows for the billing data layer.

### 11.1 Tables

| Table | Purpose |
|---|---|
| `billing_recovery_runs` | Audit log for all recovery attempts — dry-run and apply |
| `billing_recovery_actions` | Detailed step log per recovery run — one row per action |

Both tables are append-only. `billing_recovery_runs` records overall intent, scope, and result. `billing_recovery_actions` records each individual mutation planned or executed within a run.

### 11.2 Integrity Scan Engine

`billing-integrity.ts` implements five independent checks:

| Check | What it detects |
|---|---|
| `ai_usage_gaps` | Successful `ai_usage` rows without a corresponding `ai_billing_usage` row |
| `storage_usage_gaps` | `storage_usage` rows without a corresponding `storage_billing_usage` row |
| `snapshot_drift` | `billing_period_tenant_snapshots` totals deviating from live `ai_billing_usage` aggregates |
| `invoice_arithmetic` | Invoice `subtotal_usd` not matching the sum of `invoice_line_items.line_total_usd` |
| `stuck_wallet_debits` | `ai_billing_usage` rows with `wallet_status='pending'` beyond a configurable time threshold |

Scans are always read-only. They return structured findings with severity classification (`critical`, `high`, `medium`, `low`, `info`), affected counts, and sample IDs.

Snapshot drift computation uses a date-range join against `billing_periods.period_start / period_end` because `ai_billing_usage` has no `billing_period_id` foreign key.

### 11.3 Recovery Engine

`billing-recovery.ts` provides preview and apply functions for two recovery types:

**`billing_snapshot_rebuild`** — Recomputes `billing_period_tenant_snapshots` from live `ai_billing_usage` data for a given billing period. Inserts missing snapshots, updates drifted snapshots.

**`invoice_totals_rebuild`** — Recalculates `subtotal_usd` and `total_usd` on draft invoices where the stored total does not match the sum of line items. Finalized invoices are never touched.

Preview functions are always read-only. Apply functions create a `billing_recovery_runs` row and one `billing_recovery_actions` row per step. All apply operations are idempotent.

### 11.4 Recovery Audit Trail

Every recovery attempt — dry-run or real — creates a `billing_recovery_runs` row with:
- `dry_run` flag (true = no canonical billing table was modified)
- `recovery_type` (9 supported values), `scope_type` (6 values), `scope_id`
- `status` lifecycle: `started → completed | failed | skipped`
- `result_summary` JSONB (counts of executed / skipped / failed actions)

Every step creates a `billing_recovery_actions` row with `action_status` (`planned | executed | skipped | failed`), `before_state`, and `after_state` JSONB diffs.

### 11.5 Retention and Inspection

`billing-recovery-retention.ts` provides read-only helpers:
- Age report (run distribution by age bucket and type)
- Action statistics (counts by status and target table)
- Retention candidates (runs older than N days in terminal states)
- Stuck run detection (runs in `started` status beyond timeout)
- Daily trend (per-day run counts for dashboards)

`billing-recovery-summary.ts` provides:
- `listRecoveryRuns` — filterable list with aggregate action counts
- `getRecoveryRunDetail` — full run with all action rows
- `explainRecoveryRun` — structured human-readable run explanation
- `getRecoveryRunStats` — aggregate stats by recovery type and status

---

## 12. Operational Safety Rules

These rules are enforced at the application layer and must not be violated in future development:

1. **Immutable billing truth** — `ai_billing_usage` financial columns (costs, prices, margins, pricing version IDs) are never updated after insert. Only `wallet_status`, `wallet_error_message`, and `wallet_debited_at` may be updated.

2. **Append-only wallet** — `tenant_credit_ledger` rows are never deleted or updated. Every balance adjustment creates a new row.

3. **Finalized invoice protection** — `invoices` with `status='finalized'` and their `invoice_line_items` are never mutated by application code.

4. **Idempotent writes** — All billing inserts use `ON CONFLICT DO NOTHING` or unique constraint enforcement to prevent duplicate financial records.

5. **Dry-run first** — Every recovery workflow exposes a preview function that is always read-only. Preview must be called and reviewed before apply.

6. **Scan-only jobs** — Phase 4S automated jobs detect problems. They never auto-repair. Human review precedes any apply operation.

7. **Provider cost always recorded** — `ai_usage.estimated_cost_usd` is populated for every successful AI call. Null means pricing was unavailable, not that the call was free.

8. **Deterministic billing** — Given the same `ai_usage` row and the same pricing version, `ai_billing_usage` values are always reproducible. This enables recovery without guessing.

9. **No cross-tenant financial reads** — All financial queries filter by `tenant_id`. No aggregate across tenants is exposed to tenant-scoped API consumers.

10. **Distributed lock before execution** — All singleton billing jobs check `pg_try_advisory_xact_lock` before creating a run row. This prevents concurrent execution and self-blocking.

---

## 13. Admin Operations API

All admin routes are internal. They must never be exposed to tenants.

### Billing Recovery (`/api/admin/billing-recovery/`)

| Method | Path | Description |
|---|---|---|
| POST | `/scan` | Run integrity scan (read-only) |
| POST | `/preview/snapshot-rebuild` | Preview snapshot rebuild (dry-run) |
| POST | `/preview/invoice-totals-rebuild` | Preview invoice totals rebuild (dry-run) |
| POST | `/apply/snapshot-rebuild` | Apply snapshot rebuild |
| POST | `/apply/invoice-totals-rebuild` | Apply invoice totals rebuild |
| GET | `/runs` | List recovery runs (filterable by type, scope, status, dry_run) |
| GET | `/runs/:runId` | Recovery run full detail with all action rows |
| GET | `/runs/:runId/explain` | Human-readable explanation of run outcome |
| GET | `/runs/stats/summary` | Aggregate stats by type and status |
| GET | `/retention/age-report` | Run age distribution by bucket and type |
| GET | `/retention/action-stats` | Action counts by status and target table |
| GET | `/retention/candidates/:days` | Runs eligible for archival (read-only) |
| GET | `/retention/stuck-runs` | Runs stuck in started state beyond threshold |
| GET | `/retention/daily-trend` | Per-day run count trend |

### Automated Billing Jobs (`/api/admin/billing-ops/`)

| Method | Path | Description |
|---|---|---|
| GET | `/jobs` | List all job definitions |
| POST | `/jobs/seed` | Seed predefined job definitions (idempotent) |
| POST | `/jobs/:jobKey/run` | Trigger a job manually |
| GET | `/runs` | List job runs |
| GET | `/runs/:runId` | Job run detail |
| POST | `/runs/:runId/retry` | Retry a failed run |
| GET | `/health` | Job health summary |
| POST | `/scheduler/trigger` | Trigger scheduler pass |
| GET | `/scheduler/status` | Scheduler status |
| GET | `/retention/*` | Retention inspection helpers |

Additional admin route groups: `/api/admin/pricing/`, `/api/admin/plans/`, `/api/admin/subscriptions/`, `/api/admin/invoices/`, `/api/admin/billing/`, `/api/admin/monitoring/`.

---

## 14. Development Workflow

### Starting the application

```bash
npm run dev
```

This starts the Express backend and the Vite frontend dev server on the same port.

### Database schema changes

Edit `shared/schema.ts`, then push the schema:

```bash
echo "yes" | DATABASE_URL="$DATABASE_URL" npx drizzle-kit push --config=drizzle.config.ts
```

### Key conventions

- **ID convention** — All primary keys use `varchar("id").primaryKey().default(sql\`gen_random_uuid()\`)`. Never use native `uuid` type or `serial` for new tables.
- **Express 5 params** — `req.params` values are typed as `string | string[]`. Always coerce with `String(req.params.x)`.
- **Node validation** — `node --import tsx/esm -e "..."`
- **All new routes** must include Zod body / query validation before passing to service functions.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_DB_POOL_URL` | Yes | Supabase pooler connection string |
| `DATABASE_URL` | Yes | Direct database URL for migrations |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side only |
| `SESSION_SECRET` | Yes | Random string, 32+ chars |
| `OPENAI_API_KEY` | Yes | Server-side only, never client |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Yes | PAT with repo scope |

### Adding a new billing job

1. Add a `BillingJobSeed` entry to `PREDEFINED_JOBS` in `server/lib/ai/billing-jobs.ts`
2. Register an executor with `registerJobExecutor(jobKey, async (run, def) => { ... })`
3. The executor must return a plain structured object (no circular refs)
4. Call `POST /api/admin/billing-ops/jobs/seed` to seed — idempotent

---

## 15. Completed Platform Phases

| Phase | Name | Key deliverable |
|---|---|---|
| 1 | Core Platform | Schema, repositories, services, frontend shell |
| 2 | AI Run Pipeline | 4-agent chain, run executor, GitHub commit format |
| 3A | AI Foundation | `ai_usage` table, `logAiUsage()`, token / cost recording |
| 3B | AI Orchestration | `runAiCall()`, typed errors, requestId tracing |
| 3C | Provider Abstraction | `AiProvider` interface, OpenAI adapter, registry, router |
| 3D | Summarize Feature | First AI feature — `POST /api/ai/summarize` |
| 3E | Route Overrides | `ai_model_overrides`, `loadOverride()`, async router |
| 3F | Pricing Registry | `ai_model_pricing`, `loadPricing()`, `estimateAiCost()` |
| 3G | Usage Guardrails | `ai_usage_limits`, budget mode, hard stop, aggregate guardrails |
| 3H | Request Safety | Token cap (413), rate limit (429), concurrency guard (429) |
| 3I | Response Cache | SHA-256 fingerprint, TTL, tenant isolation, cache events |
| 3J | Idempotency | 2-layer duplicate suppression, in-flight 409, completed replay |
| 3K | Anomaly Detection | Per-request + window signals, tenant config override, cooldown |
| 3L | Step Budget Guard | Max 5 AI calls per request_id, 429 on exceeded |
| **4A** | AI Billing Engine | `ai_billing_usage`, provider / customer price split, margin |
| **4B** | Wallet Credit Ledger | `tenant_credit_ledger`, append-only debits, wallet status |
| **4C** | Billing Replay & Financial Safety | Replay guards, orphaned usage detection, health summaries |
| **4D** | Billing Period Locking | `billing_periods`, period open / closing / closed lifecycle |
| **4E** | Provider Reconciliation | `provider_reconciliation_runs`, discrepancy findings |
| **4F** | Invoice System | `invoices`, `invoice_line_items`, draft / finalized / void |
| **4G** | Invoice Snapshot Integrity | `billing_period_tenant_snapshots`, period close aggregation |
| **4H** | Billing Anomaly Detection | `billing_anomaly_runs`, spike and margin detectors |
| **4I** | Margin Tracking | `billing_margin_snapshots`, global / provider / tenant scope |
| **4J** | Stripe Payment Foundations | `invoice_payments`, payment status lifecycle |
| **4K** | Payment Event System | `stripe_webhook_events`, idempotent webhook processing |
| **4L** | Stripe Sync Layer | `stripe_invoice_links`, invoice-to-Stripe mapping |
| **4M** | Stripe Checkout & Webhooks | Checkout session creation, subscription webhook handling |
| **4N** | Subscription Plans & Entitlements | `subscription_plans`, `plan_entitlements`, plan lifecycle |
| **4O** | Subscription Usage Accounting | Allowance classification, `tenant_ai_allowance_usage` |
| **4P** | Invoice Automation | `admin_change_requests`, pricing / plan admin change audit |
| **4Q** | Margin Monitoring | `billing_metrics_snapshots`, monitoring summaries, alerts |
| **4R** | Automated Billing Operations | `billing_job_definitions`, `billing_job_runs`, 13 predefined jobs, scheduler |
| **4S** | Billing Integrity & Recovery | `billing_recovery_runs`, `billing_recovery_actions`, scan engine, recovery engine |
| **5A** | Document Registry & Storage Foundation | 8 tables: `knowledge_bases`, `knowledge_documents`, `knowledge_document_versions`, `knowledge_storage_objects`, `knowledge_processing_jobs`, `knowledge_chunks`, `knowledge_embeddings`, `knowledge_index_state` |
| **5B** | Knowledge Asset Layer | `knowledge_assets`, `knowledge_asset_versions`, `knowledge_asset_embeddings` — asset-level versioning + embedding lifecycle |
| **5C** | Binary Storage & Object Registry | `knowledge_storage_objects` extensions, storage class tracking, content-hash dedup foundation |
| **5D** | pgvector Similarity Search | `runVectorSearch()`, cosine/L2/inner-product metrics, full lifecycle + version + index-state safety filters, `vector-search-provider.ts` isolation boundary |
| **5E** | Retrieval Orchestration Core | `knowledge_retrieval_runs`, `retrieval-orchestrator.ts`, `chunk-ranking.ts`, `context-window-builder.ts`, token budget enforcement |
| **5F** | Trust Signal Framework | `knowledge_trust_signals`, `document-trust.ts`, per-chunk trust scores, trust-weighted retrieval, trust provenance |
| **5G** | Multimodal Asset Storage | `asset_storage_objects`, multimodal storage registry, provider-agnostic object handles |
| **5H** | Image & OCR Pipeline | `knowledge_image_embeddings`, `knowledge_ocr_results`, OpenAI Vision OCR ingestion, image chunking |
| **5I** | Media Transcript Pipeline | `knowledge_media_transcripts`, `knowledge_media_chunks`, Whisper transcription, media chunking |
| **5J** | Import Content Pipeline | `knowledge_import_sources`, `knowledge_import_runs`, structured import ingestion |
| **5K** | Embedding Lifecycle Management | `embedding_lifecycle_events`, `multimodal_embedding_sources`, re-embedding triggers, lifecycle state machine |
| **5L** | Structured Document Parsing | `knowledge_structured_documents`, `knowledge_structured_chunks`, schema-aware document parsers |
| **5M** | Retrieval Explainability & Source Provenance | `knowledge_retrieval_candidates`, `retrieval-provenance.ts`, `context-provenance.ts`, inclusion/exclusion reason codes, 9 explain admin routes |
| **5N** | Hybrid Search & Reranking Foundation | `searchable_text_tsv` generated tsvector + GIN index on `knowledge_chunks`; `lexical-search-provider.ts` (FTS), `hybrid-retrieval.ts` (RRF fusion), `reranking.ts` (deterministic reranker), 9 hybrid admin routes, 12 service-layer invariants (INV-HYB1–12) |

---

## 16. Phase 5 — Knowledge Retrieval Pipeline (5A – 5N)

Phases 5A through 5N collectively deliver a production-grade, enterprise-scale knowledge retrieval pipeline spanning 14 phases, **97 RLS-enabled tables**, and hundreds of admin routes. Each phase is additive and fully backward-compatible.

### 16.1 Architecture overview

```
Document ingestion
  └── knowledge_documents + knowledge_document_versions (Phase 5A)
  └── knowledge_storage_objects (Phase 5A/5C)
  └── knowledge_processing_jobs — async extract/chunk/embed pipeline (5A)

Chunking & Embedding
  └── knowledge_chunks  ←  searchable_text_tsv tsvector column (5N)
  └── knowledge_embeddings  ←  pgvector embedding_vector (5D)
  └── knowledge_index_state  ←  index_state per document version (5A/5D)

Retrieval pipeline
  ┌─────────────────────────────────────────────────┐
  │              retrieval-orchestrator.ts           │
  │                                                 │
  │  vector-search-provider.ts  ←→  pgvector cosine │
  │  lexical-search-provider.ts ←→  PostgreSQL FTS   │
  │         ↓                          ↓             │
  │      hybrid-retrieval.ts (RRF fusion, k=60)      │
  │              ↓                                   │
  │         reranking.ts (deterministic reranker)    │
  │              ↓                                   │
  │    chunk-ranking.ts + context-window-builder.ts  │
  └─────────────────────────────────────────────────┘

Provenance & Explainability
  └── knowledge_retrieval_candidates (5M/5N — channel, scores, ranks)
  └── retrieval-provenance.ts   — inclusion/exclusion reason codes
  └── context-provenance.ts     — context window source lineage
  └── 18 hybrid+provenance admin routes (read-only, INV-HYB7)
```

### 16.2 Key tables

| Table | Phase | Purpose |
|---|---|---|
| `knowledge_bases` | 5A | Tenant-isolated KB registry — slug, lifecycle, retrieval settings |
| `knowledge_documents` | 5A | Document registry — versioning, source type, soft-delete |
| `knowledge_document_versions` | 5A | Immutable version chain — content checksum, language, ingest status |
| `knowledge_storage_objects` | 5A/5C | Binary object handles — provider, bucket, object key, upload status |
| `knowledge_processing_jobs` | 5A | Async job queue — extract/chunk/embed, idempotency_key UNIQUE |
| `knowledge_chunks` | 5A/5N | Text chunks — chunk_key, token_estimate, `searchable_text_tsv` (generated tsvector, Phase 5N) |
| `knowledge_embeddings` | 5A/5D | Embedding metadata — provider, model, dimensions, pgvector vector |
| `knowledge_index_state` | 5A | Index tracker per document version — index_state, chunk/embedding counts |
| `knowledge_assets` | 5B | Asset-level versioning above document — asset_key, lifecycle |
| `knowledge_asset_versions` | 5B | Immutable asset version chain |
| `knowledge_asset_embeddings` | 5B | Asset-level embedding handles |
| `knowledge_trust_signals` | 5F | Per-chunk trust scores — signal_type, trust_score, source, expiry |
| `asset_storage_objects` | 5G | Multimodal storage registry — provider-agnostic object handles |
| `knowledge_image_embeddings` | 5H | Vision embedding metadata for image chunks |
| `knowledge_ocr_results` | 5H | OCR result storage — provider, confidence, bounding boxes |
| `knowledge_media_transcripts` | 5I | Audio/video transcript records — provider, language, duration |
| `knowledge_media_chunks` | 5I | Media transcript chunks — time ranges, speaker labels |
| `knowledge_import_sources` | 5J | Import source registry — source type, credentials, sync config |
| `knowledge_import_runs` | 5J | Import execution audit trail |
| `embedding_lifecycle_events` | 5K | Re-embedding trigger events — lifecycle_state, trigger_reason |
| `multimodal_embedding_sources` | 5K | Source registry for multimodal embedding generation |
| `knowledge_structured_documents` | 5L | Schema-aware structured document records |
| `knowledge_structured_chunks` | 5L | Structured document chunks — field path, data type |
| `knowledge_retrieval_runs` | 5E/5M | Per-retrieval run record — query hash, token budget, candidate counts |
| `knowledge_retrieval_candidates` | 5M/5N | Per-candidate provenance — channel_origin, vector/lexical/fused/rerank scores, pre/post ranks |

### 16.3 Retrieval invariants (Phase 5D–5N)

All retrieval operations enforce these invariants at the service layer:

- **INV-VEC / INV-LEX**: chunk_active = true, doc lifecycle = active, doc status = ready, current_version_id enforced, index_state = indexed, kb lifecycle = active
- **INV-HYB1**: All hybrid operations are tenant-safe — no cross-tenant candidate leakage
- **INV-HYB2**: Lexical search applies identical scope/lifecycle/version safety filters as vector search
- **INV-HYB3**: RRF fusion is deterministic — same inputs always produce the same ranked output
- **INV-HYB4**: Every candidate's channel origin is explicit (`vector_only` | `lexical_only` | `vector_and_lexical`)
- **INV-HYB5**: Vector score, lexical score, and fused score are always stored and explainable
- **INV-HYB6**: Reranking factors are recorded and reranking never silently changes deterministic guarantees
- **INV-HYB7**: All explain/summarize endpoints perform **zero database writes**
- **INV-HYB8**: Hybrid summaries correctly reflect channel counts
- **INV-HYB9–12**: Phase 5M provenance, Phase 5F trust signals, Phase 5L embedding lifecycle, and RLS tenant isolation are all preserved

### 16.4 Hybrid search pipeline (Phase 5N)

```
Query
  │
  ├─ vector-search-provider.ts
  │     pgvector cosine similarity → ranked vector candidates
  │
  ├─ lexical-search-provider.ts
  │     websearch_to_tsquery + ts_rank_cd → ranked lexical candidates
  │     (uses searchable_text_tsv GENERATED tsvector + GIN index)
  │
  └─ hybrid-retrieval.ts
        Reciprocal Rank Fusion (RRF, k=60)
          rrf_score = Σ weight_c / (k + rank_c)
        Channel origin assigned per candidate
        Optional: reranking.ts (fused_score + source diversity + doc balance)
        → context-window-builder.ts (token budget, dedup)
        → knowledge_retrieval_candidates persisted with full score provenance
```

### 16.5 Admin routes (Phase 5 retrieval)

All routes are internal/admin-only. Explain routes are strictly read-only (INV-HYB7).

| Route group | Count | Notes |
|---|---|---|
| `/api/admin/retrieval/run/:runId/hybrid-*` | 5 GET | hybrid-summary, hybrid-candidates, vector-candidates, lexical-candidates, channel-breakdown |
| `/api/admin/retrieval/run/:runId/fusion-explain` | 1 GET | Full RRF fusion breakdown per run |
| `/api/admin/retrieval/run/:runId/rerank-explain` | 1 GET | Reranking impact per run |
| `/api/admin/retrieval/run/:runId/final-context-scores` | 1 GET | Selected candidate scores |
| `/api/admin/retrieval/hybrid/preview` | 1 POST | Fusion preview — no persistence |
| `/api/admin/retrieval/runs/:runId/provenance` | — | Phase 5M provenance routes |
| `/api/admin/retrieval/chunks/:chunkId/explain` | — | Phase 5M chunk explain routes |

---

## 17. Long-Term Platform Vision

The platform is designed to grow through clearly scoped phases, each adding a production-grade subsystem without breaking existing contracts.

Planned future phases:

- **Phase 5O — Hybrid Retrieval Orchestrator Integration** — wire hybrid-retrieval.ts into the main retrieval-orchestrator.ts with graceful mode switching; end-to-end hybrid retrieval with full provenance
- **Phase 5P — Multilingual FTS & Locale-Aware Retrieval** — language-specific tsvector configurations, locale-aware query normalization, cross-language retrieval scoring
- **Phase 5Q — Retrieval Quality Metrics & Evaluation** — automated retrieval quality scoring, precision/recall proxies, per-KB retrieval health dashboards
- **Phase 6 — Agent Orchestration Layer** — durable multi-step agent execution with state persistence and retry
- **Phase 7 — Plan Marketplace** — self-serve plan selection, upgrade / downgrade flows, prorated billing
- **Phase 8 — Tenant Analytics** — usage dashboards, cost breakdown, anomaly history per tenant
- **Phase 9 — Compliance & Audit Export** — GDPR data export, billing audit exports, SOC 2 log retention

Each phase is additive. No phase modifies canonical financial data or retrieval contracts in a way that invalidates prior records.

---

## 18. Summary

This platform implements a complete enterprise AI control plane for a multi-tenant SaaS product. Every AI call is metered, priced, billed, and debited to a wallet. Every billing record is immutable. Every financial mutation is deterministic and recoverable.

The automated operations layer (Phase 4R) provides scheduled execution of 13 billing maintenance jobs with distributed locking, retry logic, and a full execution audit trail.

The integrity and recovery layer (Phase 4S) provides a read-only scan engine across five integrity dimensions and controlled write-recovery workflows for snapshot and invoice repair, with full before/after audit trails for every action taken.

The knowledge retrieval pipeline (Phases 5A–5N) extends the platform with 30+ tables covering document versioning, async processing, text chunking, pgvector embeddings, PostgreSQL full-text search, Reciprocal Rank Fusion hybrid retrieval, deterministic reranking, per-candidate score provenance, and 18 read-only explainability admin routes — all following the same architectural principles of immutability, idempotency, and per-tenant isolation that underpin the billing engine.

**Total schema: 97 RLS-enabled tables across 6 major subsystems.**

| Subsystem | Tables | Description |
|---|---|---|
| Core platform | ~20 | Tenants, users, projects, architectures |
| AI runtime | ~15 | Usage, requests, cache, idempotency, safety |
| Billing engine | ~35 | Billing, wallet, subscriptions, invoices, Stripe, operations, integrity |
| Document registry | ~8 | knowledge_bases, documents, versions, storage, jobs (Phase 5A) |
| Knowledge assets | ~12 | Assets, embeddings, multimodal, OCR, transcripts, imports (5B–5L) |
| Retrieval pipeline | ~7 | Chunks (FTS), index state, retrieval runs, candidates with hybrid provenance (5D–5N) |
