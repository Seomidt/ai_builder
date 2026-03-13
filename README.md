# AI Builder Platform

Enterprise multi-tenant AI SaaS backend platform providing AI runtime orchestration, usage metering, a complete billing engine, wallet ledger, subscription plans, Stripe payments, automated billing operations, a billing integrity and recovery system, and a document registry with versioning, processing pipelines, embedding metadata, and vector index management.

---

## 1. Project Overview

This repository implements the control plane for an AI-driven software generation platform. It is designed for production operation at scale:

- 1 000+ tenants
- 50 000+ users
- Millions of AI requests per billing period

The platform separates concerns cleanly across an AI runtime pipeline, a multi-layer billing engine, a wallet credit system, a subscription entitlement layer, a Stripe payment integration, and an automated operations layer with integrity scanning and recovery workflows.

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
| **5A** | Document Registry & Storage Foundation | `knowledge_bases`, `knowledge_documents`, `knowledge_document_versions`, `knowledge_storage_objects`, `knowledge_processing_jobs`, `knowledge_chunks`, `knowledge_embeddings`, `knowledge_index_state` |

---

## 16. Phase 5A — Document Registry & Storage Foundation

Phase 5A introduces a production-grade document management subsystem with 8 new tables (total: 85 tables), 4 lib files, and 20 admin routes.

### New tables

| Table | Purpose |
|---|---|
| `knowledge_bases` | Tenant-isolated KB registry with slug, lifecycle_state, visibility, default_retrieval_k |
| `knowledge_documents` | Enterprise document registry — knowledge_base_id FK, source_type, document_status, current_version_id (no FK — enforced at service layer), soft-delete |
| `knowledge_document_versions` | Immutable version chain — version_number, is_current flag, content_checksum, language_code, processing timestamps |
| `knowledge_storage_objects` | Binary object references — storage_provider, bucket_name, object_key, upload_status, soft-delete |
| `knowledge_processing_jobs` | Async job queue — job_type, status lifecycle, priority, idempotency_key (UNIQUE), worker_id, payload/result JSONB |
| `knowledge_chunks` | Text chunks — chunk_key (NOT NULL, content-addressable), chunk_index, source ranges, token_estimate |
| `knowledge_embeddings` | Embedding metadata — embedding_provider (NOT NULL), embedding_model (NOT NULL), vector_backend, vector_status, dimensions |
| `knowledge_index_state` | Per-document-version index tracker — index_state, chunk_count, indexed_chunk_count, embedding_count, last_indexed_at |

### Key capabilities

- **Knowledge base management** — tenant-scoped KBs with lifecycle control (draft → active → archived) and configurable retrieval settings
- **Document versioning** — every upload creates a new immutable version; `current_version_id` is managed at the service layer (no FK due to circular dependency)
- **Processing pipelines** — durable job queue tracks extract, chunk, and embed operations with `pending → running → completed | failed | retrying` lifecycle
- **Embedding metadata** — provider, model, dimensions, and vector backend recorded at embedding time for future re-indexing and cost attribution
- **Vector index management** — index build state tracked independently from embedding generation, enabling partial rebuilds without re-embedding
- **Soft-delete support** — documents and storage objects use `deleted_at` for non-destructive removal

### Design invariants

- `knowledge_documents.current_version_id` has **no FK** — circular dependency with `knowledge_document_versions`; validity enforced by `setCurrentDocumentVersion()` at service layer
- `knowledge_index_state.knowledge_document_id` is **NOT NULL** — state scoped to a specific document, not just KB
- `chunk_key` is **NOT NULL** — content-addressable identifier set at ingestion time
- `embedding_provider` and `embedding_model` are **NOT NULL** — required for cost attribution and re-indexing
- `knowledge_bases.slug` is **NOT NULL** — URL-safe tenant-unique identifier

The document system follows the same architectural principles as the billing engine: immutable records, durable audit logs, idempotent operations, and strict per-tenant isolation.

---

## 17. Long-Term Platform Vision

The platform is designed to grow through clearly scoped phases, each adding a production-grade subsystem without breaking existing contracts.

Planned future areas:

- **Phase 5B — Vector Search & Retrieval** — vector similarity search, hybrid BM25+vector retrieval, relevance scoring
- **Phase 6 — Agent Orchestration Layer** — durable multi-step agent execution with state persistence and retry
- **Phase 7 — Plan Marketplace** — self-serve plan selection, upgrade / downgrade flows, prorated billing
- **Phase 8 — Tenant Analytics** — usage dashboards, cost breakdown, anomaly history per tenant
- **Phase 9 — Compliance & Audit Export** — GDPR data export, billing audit exports, SOC 2 log retention

Each phase is additive. No phase modifies canonical financial data in a way that invalidates prior billing records.

---

## 18. Summary

This platform implements a complete enterprise AI control plane for a multi-tenant SaaS product. Every AI call is metered, priced, billed, and debited to a wallet. Every billing record is immutable. Every financial mutation is deterministic and recoverable.

The automated operations layer (Phase 4R) provides scheduled execution of 13 billing maintenance jobs with distributed locking, retry logic, and a full execution audit trail.

The integrity and recovery layer (Phase 4S) provides a read-only scan engine across five integrity dimensions and controlled write-recovery workflows for snapshot and invoice repair, with full before/after audit trails for every action taken.

The document registry layer (Phase 5A) extends the platform with 8 new tables for knowledge base management, document versioning, binary storage tracking, async processing pipelines, text chunking, embedding metadata, and vector index state — all following the same architectural principles of immutability, idempotency, and per-tenant isolation that underpin the billing engine.

**Total schema: 85 tables across 5 major subsystems.**
