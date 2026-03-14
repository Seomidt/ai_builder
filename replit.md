# AI Builder Platform — V1 (Phase 5G complete)

Internal control plane for AI-driven software generation. Express + React + Drizzle ORM + Supabase.

## Stack

- **Frontend**: React 19, Wouter (routing), TanStack Query, Shadcn UI, Tailwind CSS (dark navy/teal theme)
- **Backend**: Express.js, TypeScript, Zod validation
- **Auth**: Supabase Auth (JWT middleware wired, demo fallback for dev)
- **Database**: Supabase Postgres (PostgreSQL 17.6) via Drizzle ORM + connection pooler
- **AI**: OpenAI (Responses API) — provider-abstracted via AiProvider interface
- **GitHub**: `GITHUB_PERSONAL_ACCESS_TOKEN` available server-side

## User Preferences

- **Sprog**: Kommuniker på dansk
- **iPhone-bruger**: Kan ikke paste tekst i Replit shell fra iPhone — giv altid korte, trin-for-trin shell-kommandoer der kan skrives manuelt, én ad gangen
- **GitHub**: Remote URL bruger `$GITHUB_PERSONAL_ACCESS_TOKEN` — repo: `github.com/Seomidt/ai_builder`

## Key Design Rules

- **No hard delete**: `projects`, `architecture_profiles`, `ai_runs` use `status` field
- **Architecture versioning is first-class**: `current_version_id` + `is_published` on versions
- **AI Runs as lifecycle**: dedicated append ops for steps, artifacts, tool calls, approvals
- **All AI calls go through `runAiCall()`** — never call generateText() or logAiUsage() directly
- **Overrides are route_key-based** — features map to route keys; route keys map to DB overrides
- **Feature pattern**: Features in `server/features/<name>/`, prompts in `server/lib/ai/prompts/`
- **Multi-tenancy**: `organization_id` only on top-level entities; children inherit via FK
- **Server-side secrets only**: GitHub/OpenAI/Supabase service role never reach the client
- **Idempotency requires request_id**: duplicate suppression only activates when `X-Request-Id` is present
- **Cache hits produce no cost rows**: observable via ai_cache_events only
- **Failed request_ids are retryable**: transient provider errors do not permanently block a request_id
- **Retention is manual**: no scheduler in Phases 3–4; cleanup SQL provided in retention foundation files
- **Billing jobs use distributed locking**: pg_try_advisory_xact_lock (Layer 1) + started-row singleton check (Layer 2). Lock check before run row creation — prevents self-blocking on retry
- **Scan-only jobs never auto-repair**: Phase 4S jobs detect, never fix. Human review precedes any apply call
- **Recovery preview is always read-only**: preview functions never write to canonical billing tables — enforced in billing-recovery.ts
- **ai_billing_usage has NO billing_period_id FK**: period attribution via date-range join on billing_periods.period_start/period_end. NEVER assume a direct FK
- **storage_usage timestamp column is created_at**: NOT recorded_at — critical for retention and gap queries
- **Finalized invoices never mutated by recovery**: invoice_totals_rebuild only touches draft invoices
- **All recovery operations are idempotent**: apply functions safe to re-run on same scope/period
- **knowledge_documents.current_version_id has NO FK**: circular dependency — invariant enforced at service layer via setCurrentDocumentVersion()
- **knowledge_index_state has knowledge_document_id NOT NULL**: each index_state row scoped to a specific document version, not only to kb
- **chunk_key is NOT NULL**: unique content-addressable identifier per chunk — set at ingestion time
- **embedding_provider is NOT NULL**: 'openai', 'cohere', etc. — required for re-indexing and cost attribution
- **knowledge_bases.slug is NOT NULL**: URL-safe unique identifier within tenant; set at creation time
- **Anomaly detection is observational only**: no runtime blocking in Phase 3K — events only
- **Step budget is per request_id**: cache hits, replays, and pre-flight blocks never consume a step
- **Step budget fail-open**: DB errors in step-budget.ts allow the call through — observability must not block runtime
- **Billing is downstream of ai_usage**: billing row only created after confirmed successful ai_usage insert
- **Billing rows are immutable**: pricing changes never mutate past ai_billing_usage rows
- **Billing is fail-open**: DB errors in billing.ts are caught and logged — never propagated to AI runtime
- **One billing row per ai_usage row**: UNIQUE on usage_id enforces this at DB level
- **Wallet hard-limit check at step 8.5**: runner.ts checks available_balance_usd <= hard_limit_usd before provider call — throws AiWalletLimitError (402); DB errors are fail-open
- **wallet_status flow**: `pending` (insert default) → `debited` (on success) or `failed` (on wallet write error). Updated by billing.ts post-insert only
- **Wallet debit replay is idempotent**: billing_usage_id partial unique index on ledger prevents double-debits; replay scripts via wallet-replay.ts
- **Reconciliation is detection-only**: ai_provider_reconciliation_runs/deltas record discrepancies; never auto-corrects billing rows
- **AiWalletLimitError (402)**: HTTP 402, pre-flight block — no provider call, no billing row, no debit. Tenant must add credits
- **Billing period lifecycle**: open → closing → closed — only manual close via closeBillingPeriod(); no auto-scheduler in Phase 5
- **Snapshot immutability**: billing_period_tenant_snapshots are never updated/deleted after creation — UNIQUE(billing_period_id, tenant_id) enforces idempotency
- **Reporting source rule**: open period → live ai_billing_usage; closed period → billing_period_tenant_snapshots (enforced via getBillingDataSourceForPeriod)
- **Period inclusion rule**: created_at >= period_start AND < period_end (inclusive start, exclusive end — consistent throughout)
- **Snapshot source**: all amounts from ai_billing_usage (canonical); debited_amount_usd = SUM(customer_price_usd) WHERE wallet_status='debited'
- **Zero-usage tenants excluded**: no snapshot rows created for tenants with no billing activity in the period

## Environment Variables Required

| Variable | Required | Notes |
|----------|----------|-------|
| `SUPABASE_DB_POOL_URL` | Yes | Supabase pooler connection string |
| `SUPABASE_URL` | Yes | Project URL |
| `SUPABASE_ANON_KEY` | Yes | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side only — never client |
| `SESSION_SECRET` | Yes | Random string 32+ chars |
| `OPENAI_API_KEY` | Yes | Server-side only |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Yes | PAT with repo scope |

## Project Structure

```
client/src/
  components/layout/   AppShell, Sidebar
  pages/               dashboard, projects, architectures, runs, integrations, settings
  lib/                 queryClient, utils

server/
  lib/
    ai/
      config.ts                  AI_MODEL_ROUTES, AiProviderKey, runtime limits, cache policies
      runner.ts                  runAiCall() — single orchestration entry point (15 steps)
      router.ts                  resolveRoute() — async, override-aware
      overrides.ts               loadOverride() — DB override loader + TTL cache
      types.ts                   AiCallContext, AiCallResult
      errors.ts                  Typed error hierarchy — AiError + 10 subclasses
      usage.ts                   logAiUsage() → ai_usage + tenant_ai_usage_periods + anomaly detection
      usage-periods.ts           getCurrentPeriod() — calendar month boundary
      pricing.ts                 loadPricing() — DB first, code default fallback + TTL cache
      costs.ts                   estimateAiCost() — token × rate
      guards.ts                  AI usage guardrails — budget mode, blocked, thresholds
      usage-summary.ts           getAiUsageSummary() — normalized tenant usage contract
      request-safety.ts          Token cap, rate limit, concurrency guard
      request-safety-summary.ts  getRequestSafetySummary() — backend summary
      response-cache.ts          Tenant-isolated AI response cache (SHA-256 fingerprint)
      cache-summary.ts           getCacheSummary() — hit/miss/write counts
      cache-retention.ts         Batch cleanup SQL for expired ai_response_cache rows
      idempotency.ts             2-layer duplicate suppression (in-process Set + DB)
      request-state-summary.ts   getAiRequestStateSummary() — idempotency state counts
      request-state-retention.ts Cleanup SQL for ai_request_states + ai_request_state_events
      anomaly-detector.ts        runAnomalyDetection() — per-request + window cost/token anomalies
      anomaly-summary.ts         getAnomalySummary() — recent anomaly event counts
      anomaly-retention.ts       Cleanup SQL for ai_anomaly_events (90-day retention)
      step-budget.ts             acquireAiStep() — per-request AI call limit (default: 5)
      step-budget-summary.ts     getStepBudgetSummary() — active/exhausted/completed requests
      step-budget-retention.ts   Cleanup SQL for ai_request_step_states + ai_request_step_events
      billing.ts                 loadEffectiveCustomerPricingConfig(), calculateCustomerPrice(), maybeRecordAiBillingUsage()
      billing-summary.ts         getAiBillingSummary() — provider cost / customer price / margin per tenant
      billing-retention.ts       SQL foundation for ai_billing_usage cleanup (24-month retention)
      retention.ts               Cleanup SQL for ai_usage rows (90-day window)
      providers/                 AiProvider interface, OpenAI adapter, registry
      prompts/                   getSummarizePrompt()
    supabase.ts, github.ts, github-commit-format.ts
  features/
    ai-summarize/                summarize.service.ts
  middleware/                    auth.ts (JWT → req.user)
  repositories/                  projects, architectures, runs, integrations, knowledge
  services/                      projects, architectures, runs, integrations, run-executor
  routes.ts                      Thin API handlers
  storage.ts                     IStorage + DatabaseStorage
  db.ts                          Drizzle + pg pool

    lib/
      ai/
        billing-job-locks.ts           pg_try_advisory_xact_lock + started-row singleton guard (Phase 4R)
        billing-operations.ts          runBillingJob() — job engine, lifecycle, executor registry (Phase 4R)
        billing-jobs.ts                13 predefined jobs + executor registrations (Phase 4R+4S)
        billing-job-health.ts          health summary, stale run detection, job state explanation (Phase 4R)
        billing-scheduler.ts           interval-based scheduler, due-job detection (Phase 4R)
        billing-ops-retention.ts       inspection helpers for job runs — read-only (Phase 4R)
        billing-integrity.ts           read-only scan engine: 5 checks across billing tables (Phase 4S)
        billing-recovery.ts            preview + apply for snapshot rebuild + invoice totals rebuild (Phase 4S)
        billing-recovery-summary.ts    listRecoveryRuns, getRecoveryRunDetail, explainRecoveryRun, stats (Phase 4S)
        billing-recovery-retention.ts  age report, action stats, stuck runs, daily trend — read-only (Phase 4S)

shared/
  schema.ts                      All Drizzle tables + insert schemas + TypeScript types (77 tables after Phase 4S)
```

## Phase History

| Phase | Branch | Status |
|-------|--------|--------|
| 1 | `main` | Core platform — schema, repos, services, UI |
| 2 | `main` | AI run pipeline — 4 agents, run executor, GitHub commit format |
| 3A | `main` | AI foundation — config, ai_usage table, logAiUsage() |
| 3B | `main` | AI orchestration — runAiCall(), AiCallContext, typed errors, requestId |
| 3C | `feature/ai-router` | Provider abstraction — AiProvider, OpenAI adapter, registry, router |
| 3D | `feature/ai-summarize` | First AI feature — summarize prompt, service, POST /api/ai/summarize |
| 3E | `feature/ai-route-overrides` | Model routing overrides — ai_model_overrides, loadOverride(), async router |
| 3F | `feature/ai-pricing-registry` | AI Pricing Registry — ai_model_pricing, loadPricing(), estimateAiCost(), estimated_cost_usd |
| 3G | `feature/ai-usage-guardrails` | AI Usage Guardrails — ai_usage_limits, usage_threshold_events, guards.ts, budget mode, hard stop |
| 3G.1 | `feature/ai-usage-hardening` | Usage Hardening — tenant_ai_usage_periods aggregate, getCurrentPeriod(), aggregate-first guardrails |
| 3H | `feature/ai-usage-final-hardening` | Request Safety — token cap (413), rate limit (429), concurrency guard (429), request_safety_events |
| 3H.1 | `feature/http-error-semantics` | HTTP Error Semantics — httpStatus + errorCode + Retry-After on all AiError subclasses |
| 3I | `feature/ai-response-cache` | AI Response Cache — SHA-256 fingerprint, TTL, tenant isolation, cache events |
| 3I.1 | `feature/ai-response-cache` | Cache Key Hardening — maxOutputTokens in fingerprint |
| 3I.2 | `feature/cache-cleanup-foundation` | Cache Cleanup Foundation — preview + batch cleanup SQL |
| 3I.3 | `feature/cache-batch-cleanup` | Batch Cache Cleanup — oldest-first deletion, CACHE_CLEANUP_BATCH_SIZE |
| 3J | `feature/ai-idempotency-layer` | AI Idempotency — 2-layer duplicate suppression, inflight 409, completed replay, failed retry |
| 3J.1 | `feature/request-state-retention` | Request State Retention — expires_at states cleanup, 30-day events cleanup SQL |
| 3K | `feature/ai-cost-anomaly-detection` | AI Cost Anomaly Detection — ai_anomaly_configs + ai_anomaly_events, per-request + window detection, 15m cooldown |
| 3L | `feature/ai-step-budget-guard` | AI Step Budget Guard — ai_request_step_states + ai_request_step_events, max 5 AI calls per request_id |
| 4A | `feature/ai-billing-engine` | AI Billing Engine — ai_customer_pricing_configs + ai_billing_usage, 3 pricing modes, immutable ledger, margin tracking |
| 4B | `feature/wallet-credit-ledger` | Wallet/Credit Ledger — tenant_credit_accounts + tenant_credit_ledger, immutable ledger, gross/available balance, billing-driven debit, expiration-ready, fail-open |
| 4C | `feature/billing-replay-safety` | Billing Replay & Financial Safety — replay guards, orphaned usage detection, health summaries |
| 4D | `feature/billing-period-locking` | Billing Period Locking — billing_periods, period open/closing/closed lifecycle |
| 4E | `feature/provider-reconciliation` | Provider Reconciliation — provider_reconciliation_runs, discrepancy findings |
| 4F | `feature/invoice-system` | Invoice System — invoices, invoice_line_items, draft/finalized/void |
| 4G | `feature/invoice-snapshot-integrity` | Invoice Snapshot Integrity — billing_period_tenant_snapshots, period close aggregation |
| 4H | `feature/billing-anomaly-detection` | Billing Anomaly Detection — billing_anomaly_runs, spike and margin detectors |
| 4I | `feature/margin-tracking` | Margin Tracking — billing_margin_snapshots, global/provider/tenant scope |
| 4J | `feature/stripe-payment-foundations` | Stripe Payment Foundations — invoice_payments, payment status lifecycle |
| 4K | `feature/payment-event-system` | Payment Event System — stripe_webhook_events, idempotent webhook processing |
| 4L | `feature/stripe-sync-layer` | Stripe Sync Layer — stripe_invoice_links, invoice-to-Stripe mapping |
| 4M | `feature/stripe-checkout-webhooks` | Stripe Checkout & Webhooks — checkout session creation, subscription webhook handling |
| 4N | `feature/subscription-plans-entitlements` | Subscription Plans & Entitlements — subscription_plans, plan_entitlements, plan lifecycle |
| 4O | `feature/subscription-usage-accounting` | Subscription Usage Accounting — allowance classification, tenant_ai_allowance_usage |
| 4P | `feature/admin-pricing-plan-management` | Invoice Automation — admin_change_requests, pricing/plan admin change audit |
| 4Q | `feature/billing-observability-monitoring` | Margin Monitoring — billing_metrics_snapshots, monitoring summaries, alerts |
| 4R | `feature/automated-billing-operations` | Automated Billing Operations — billing_job_definitions, billing_job_runs, 13 predefined jobs, scheduler |
| 4S | `feature/billing-recovery-integrity` | Billing Integrity & Recovery — billing_recovery_runs, billing_recovery_actions, scan engine, recovery engine |

## AI Stack — Full Pipeline (runner.ts)

```
runAiCall(context, input)
  1.  resolveRoute(routeKey, tenantId)
        → loadOverride() — tenant → global → null
        → fallback: AI_MODEL_ROUTES[routeKey]
  2.  getProvider(provider)
  3.  [if tenantId + requestId] beginAiRequest()
        → duplicate_inflight  → throw AiDuplicateInflightError (409, Retry-After: 5)
        → duplicate_replay    → return stored AiCallResult (no provider call, no cost row)
        → owned               → proceed; release in finally
  4.  resolveEffectiveSafetyConfig(tenantId)
  5.  [if tenantId] checkTokenCap()          → 413 on violation
  6.  [if tenantId] checkRateLimit()         → 429 on violation (Retry-After: 60 or 3600)
  7.  [if tenantId] acquireConcurrencySlot() → 429 on violation (Retry-After: 5)
  8.  [if tenantId] loadUsageLimit() + getCurrentAiUsageForPeriod()
        → blocked    → throw AiBudgetExceededError (402)
        → budget_mode → apply BUDGET_MODE_POLICY (maxOutputTokens: 512, concise prefix)
  9.  [if cacheable + tenantId] lookupCachedResponse()
        → HIT  → return cached AiCallResult (no provider call, no cost row, no step)
        → MISS → continue
 10.  [if tenantId + requestId] acquireAiStep()
        → exceeded  → throw AiStepBudgetExceededError (429, step_budget_exceeded)
        → within limit → increment counter, record step_started event, continue
 11.  provider.generateText(...)
 12.  logAiUsage(...) + maybeRecordThresholdEvent() + runAnomalyDetection() [fire-and-forget]
       → maybeRecordAiBillingUsage() [fire-and-forget: ai_billing_usage + wallet debit]
 13.  [if cacheable + tenantId] storeCachedResponse()
 14.  [if idp owned] markAiRequestCompleted()
 15.  finally: releaseConcurrencySlot() + releaseAiRequestOwnership()
```

## Key Files

- `shared/schema.ts` — all 29 tables
- `server/lib/ai/config.ts` — AI_MODEL_ROUTES (6 routes), cache policies
- `server/lib/ai/runner.ts` — runAiCall() — 15-step orchestration pipeline
- `server/lib/ai/router.ts` — resolveRoute() (async, override-aware)
- `server/lib/ai/overrides.ts` — loadOverride() + TTL cache
- `server/lib/ai/pricing.ts` — loadPricing() + TTL cache
- `server/lib/ai/costs.ts` — estimateAiCost() + code defaults
- `server/lib/ai/guards.ts` — budget mode, blocked state, threshold events
- `server/lib/ai/usage-periods.ts` — getCurrentPeriod() — period boundaries
- `server/lib/ai/usage-summary.ts` — getAiUsageSummary()
- `server/lib/ai/request-safety.ts` — token cap, rate limit, concurrency guard
- `server/lib/ai/response-cache.ts` — lookupCachedResponse() + storeCachedResponse()
- `server/lib/ai/cache-retention.ts` — deleteExpiredCacheEntriesBatch()
- `server/lib/ai/idempotency.ts` — beginAiRequest(), markAiRequestCompleted(), markAiRequestFailed()
- `server/lib/ai/request-state-retention.ts` — PREVIEW/DELETE SQL for states + events
- `server/lib/ai/anomaly-detector.ts` — loadEffectiveAnomalyConfig(), runAnomalyDetection()
- `server/lib/ai/anomaly-summary.ts` — getAnomalySummary()
- `server/lib/ai/anomaly-retention.ts` — runAnomalyEventCleanup() (90-day retention)
- `server/lib/ai/step-budget.ts` — acquireAiStep(), recordStepCompleted(), finalizeAiStepBudget()
- `server/lib/ai/step-budget-summary.ts` — getStepBudgetSummary()
- `server/lib/ai/step-budget-retention.ts` — runStepStateCleanup() + runStepEventCleanup()
- `server/lib/ai/billing.ts` — loadEffectiveCustomerPricingConfig(), calculateCustomerPrice(), maybeRecordAiBillingUsage() → triggers wallet debit
- `server/lib/ai/billing-summary.ts` — getAiBillingSummary()
- `server/lib/ai/billing-retention.ts` — getBillingRetentionSql() (24-month default)
- `server/lib/ai/wallet.ts` — ensureTenantCreditAccount(), grantTenantCredits(), debitTenantCreditsForBillingUsage(), getTenantCreditBalance(), maybeRecordWalletDebit()
- `server/lib/ai/wallet-summary.ts` — getTenantWalletSummary() (gross + available balance)
- `server/lib/ai/wallet-retention.ts` — getWalletRetentionSql() (24-month default)
- `server/lib/ai/retention.ts` — PREVIEW/DELETE SQL for ai_usage (90-day window)
- `server/lib/ai/errors.ts` — AiError + 10 typed subclasses with httpStatus + errorCode + retryAfterSeconds
- `server/lib/ai/billing-job-locks.ts` — acquireBillingJobLock() via pg_try_advisory_xact_lock + started-row guard (Phase 4R)
- `server/lib/ai/billing-operations.ts` — runBillingJob(), createJobRun(), completeJobRun(), failJobRun(), registerJobExecutor() (Phase 4R)
- `server/lib/ai/billing-jobs.ts` — PREDEFINED_JOBS (13), ensureBillingJobDefinitions() (Phase 4R+4S)
- `server/lib/ai/billing-job-health.ts` — getBillingJobHealthSummary(), detectStaleRuns() (Phase 4R)
- `server/lib/ai/billing-scheduler.ts` — triggerScheduler(), getDueJobs() (Phase 4R)
- `server/lib/ai/billing-ops-retention.ts` — read-only inspection helpers for job runs (Phase 4R)
- `server/lib/ai/billing-integrity.ts` — runBillingIntegrityScan() — 5 checks, always read-only (Phase 4S)
- `server/lib/ai/billing-recovery.ts` — previewSnapshotRebuild(), applySnapshotRebuild(), previewInvoiceTotalsRebuild(), applyInvoiceTotalsRebuild() (Phase 4S)
- `server/lib/ai/billing-recovery-summary.ts` — listRecoveryRuns(), getRecoveryRunDetail(), explainRecoveryRun(), getRecoveryRunStats() (Phase 4S)
- `server/lib/ai/billing-recovery-retention.ts` — age report, action stats, stuck runs, daily trend — read-only (Phase 4S)
- `server/routes/admin.ts` — all /api/admin/* routes including billing-ops (17 routes) and billing-recovery (14 routes)

## Database Notes

- **Demo org**: `demo-org`, projectId `ebd30281-0f9c-43c8-bb06-c20e531e8fc4`
- **DB push command**: `npm run db:push`
- `ai_model_overrides` — partial unique expression index via SQL: `CREATE UNIQUE INDEX ... WHERE is_active = true`
- `ai_model_pricing` — partial unique index `ON ai_model_pricing (provider, model) WHERE is_active = true`
- `ai_usage.estimated_cost_usd` is `numeric(12,8)` — Drizzle returns as string, convert with `Number()` when reading
- `tenant_ai_usage_periods` — aggregate summary (Phase 3G.1). One row per tenant+period. Updated synchronously via ON CONFLICT DO UPDATE.
- `ai_response_cache` — unique index on `(tenant_id, cache_key)`. TTL 3600s. Only `"default"` route cached. Cache hits produce NO ai_usage cost rows.
- `ai_request_states` — unique index on `(tenant_id, request_id)`. TTL 24h. Failed state is retryable.
- `ai_request_state_events` — 30-day retention window. Append-only.
- `ai_anomaly_configs` — scope CHECK IN ('global','tenant'). Partial unique indexes for one active global + one active tenant row. Config resolution: tenant → global → code defaults.
- `ai_anomaly_events` — cooldown_key prevents duplicate spam within 15-minute window. 90-day retention.
- `ai_request_step_states` — unique index on `(tenant_id, request_id)`. TTL 24h. Default max_ai_calls = 5.
- `ai_request_step_events` — 30-day retention. step_budget_exceeded events logged before throw.
- `ai_customer_pricing_configs` — scope CHECK IN ('global','tenant'). pricing_mode CHECK IN ('cost_plus_multiplier','fixed_markup','per_1k_tokens'). Partial unique indexes for one active global + one active tenant row. Config resolution: tenant → global → code default (3× multiplier).
- `ai_billing_usage` — UNIQUE on usage_id. Immutable ledger. One row per ai_usage row max. Never written for blocked/error/cache-hit/replay calls. 24-month recommended retention. Composite index `(tenant_id, created_at)` added Phase 4B.
- `tenant_credit_accounts` — one wallet account per tenant (UNIQUE on tenant_id). Metadata only — balance NOT stored here. Currency: USD.
- `tenant_credit_ledger` — immutable wallet event ledger. Source of truth for balance. entry_type CHECK IN ('credit_grant','credit_debit','credit_expiration','credit_adjustment'). direction CHECK IN ('credit','debit'). Partial unique index on `billing_usage_id WHERE entry_type='credit_debit'` ensures one debit per billing row. expires_at support for credit expiration. 24-month retention.
- **Balance model**: gross_balance_usd = SUM(all credits) - SUM(all debits). available_balance_usd = SUM(non-expired credits) - SUM(all debits).
- **Wallet debit flow**: provider call → ai_usage → ai_billing_usage → wallet debit (all downstream, fail-open). Wallet failure never breaks runtime.
- **All ID columns**: `varchar("id").primaryKey().default(sql\`gen_random_uuid()\`)` — never native uuid type
- **Numeric DB fields**: Drizzle returns `numeric` as strings — convert with `Number()` when reading

## Running

```bash
npm run dev       # Start dev server (port 5000)
npm run db:push   # Sync schema to DB
```

## Current Status & Next TODO

### Completed (Phase 4S, commit 2abe180, branch feature/billing-recovery-integrity)
- [x] Phase 4A–4S: Full monetization engine — billing, wallet, subscriptions, invoices, Stripe, jobs, integrity, recovery
- [x] README.md updated to reflect Phase 4S architecture

### Next phase
- [ ] **Phase 5A: Document Registry & Storage Foundation**
  - New tables: knowledge_documents, knowledge_document_versions, knowledge_storage_objects, knowledge_processing_jobs, knowledge_chunks, knowledge_embeddings, knowledge_index_state
  - Branch: feature/document-registry (from Phase 4S tip commit 2abe180)
  - Declaration uploaded — ready to implement

### Future work
- [ ] Admin UI for billing operations dashboard
- [ ] Real Supabase Auth session (frontend login/signup)
- [ ] GitHub tool execution (create branch, write files, open PR)
- [ ] Full RLS policies on all tenant tables
- [ ] Retention cron jobs (billing_job_runs integration in Phase 5+)

## Phase 4P — Admin Pricing & Plan Management System (complete, branch: feature/admin-pricing-plan-management)

### New tables (schema.ts)
- `admin_change_requests` — durable audit log for all admin pricing/plan operations. Append-only, status lifecycle: pending → applied|rejected|failed. 8-value change_type CHECK, 3-value status CHECK, 3-value target_scope CHECK. 4 indexes.
- `admin_change_events` — immutable timeline per change request. Never updated or deleted. 2 indexes.

### New lib files
- `server/lib/ai/admin-pricing.ts` — preview + apply for provider/customer/storage/customer-storage pricing version creation. Overlap detection (windowsOverlap). Every operation records admin change request + events.
- `server/lib/ai/admin-plans.ts` — preview + apply plan creation, entitlement replacement (atomic tx: delete all + bulk insert), archive plan, list plans, explainPlanDefinition.
- `server/lib/ai/admin-tenant-subscriptions.ts` — preview + apply tenant plan change (uses changeTenantSubscription with billing period derivation from plan.billingInterval), preview + apply plan cancellation (uses cancelTenantSubscription), list subscription history with plan join.
- `server/lib/ai/admin-commercial-preview.ts` — previewPricingImpactForTenant, previewPlanImpactForTenant (entitlement diff: added/removed/changed keys), previewGlobalPricingWindowChange, explainAdminChangePreview.
- `server/lib/ai/admin-change-summary.ts` — listAdminChangeRequests, getAdminChangeRequestById, listAdminChangeEvents, explainAdminChangeResult.
- `server/lib/ai/admin-change-retention.ts` — explainAdminChangeRetentionPolicy (read-only), previewPendingAdminChangesOlderThan, previewFailedAdminChangesOlderThan, previewAppliedAdminChangesWithoutEvents, previewPlanRowsStillReferencedHistorically.

### New routes
- `server/routes/admin.ts` — 25 endpoints under /api/admin/ for pricing preview/apply, plan CRUD, tenant subscription change/cancel, commercial preview, change history, retention inspection. Registered in server/routes.ts via registerAdminRoutes(app).

### Key design rules enforced
- No edit-in-place on pricing versions — always new rows
- Overlap detection blocks apply when effectiveFrom windows conflict
- Historical billing rows and plans are never deleted
- All admin operations produce admin_change_requests + admin_change_events trail

## Phase 4Q — Billing Observability & Monitoring (complete, branch: feature/billing-observability-monitoring)

### New tables (schema.ts)
- `billing_metrics_snapshots` — observability snapshots of billing metrics. Read-derived, NOT accounting truth. Lifecycle: started → completed | failed. 3-value snapshotStatus CHECK, 3-value scopeType CHECK (global/tenant/billing_period), window_check (end > start). 4 indexes.
- `billing_alerts` — operational alert objects for billing anomalies. Deduplication via alert_key + open/acknowledged status. Status lifecycle: open → acknowledged → resolved | suppressed. 3-value severity CHECK, 4-value status CHECK, 5-value scopeType CHECK. 4 indexes.

### New lib files
- `server/lib/ai/billing-observability.ts` — Phase 4C foundation preserved (getBillingHealthSummary, getTenantBillingHealthSummary). Phase 4Q extends with: createGlobalBillingMetricsSnapshot, createTenantBillingMetricsSnapshot, createBillingPeriodMetricsSnapshot, getLatestGlobalBillingMetrics, getLatestTenantBillingMetrics, getLatestBillingPeriodMetrics. Snapshot engine: started → completed|failed persistence with full metrics JSON (ai, storage, invoices, payments, subscriptions).
- `server/lib/ai/billing-anomalies.ts` — 6 anomaly detectors: revenue_drop (vs prior window, 20% threshold), margin_drop (AI margin < 5% critical / 10% warning), failed_payment_spike (>10% or >5 absolute), invoice_payment_mismatch (finalized >7 days with no paid payment), reconciliation_gap (critical findings), overage_spike (>50% vs prior). runBillingAnomalyScan() runs all 6 in parallel, returns error report. Each detector calls upsertBillingAlert() for deduplication.
- `server/lib/ai/billing-monitoring-summary.ts` — 7 read-only summary helpers: getInvoiceMonitoringSummary, getPaymentMonitoringSummary, getSubscriptionMonitoringSummary, getReconciliationMonitoringSummary, getAllowanceMonitoringSummary, getTenantMonetizationHealthSummary, getGlobalMonetizationHealthSummary. All accept optional windowStart/windowEnd/tenantId.
- `server/lib/ai/billing-alerts.ts` — upsertBillingAlert (deduplication via alertKey + active status), listOpenBillingAlerts, listBillingAlertsByScope, acknowledgeBillingAlert, resolveBillingAlert, suppressBillingAlert, explainBillingAlert (age/status explanation).
- `server/lib/ai/billing-monitoring-retention.ts` — inspection-only helpers: explainBillingMonitoringRetentionPolicy, previewFailedMetricsSnapshotsOlderThan, previewOpenCriticalAlertsOlderThan, previewMonitoringGaps, previewTenantsWithoutRecentMetricsSnapshots. No destructive cleanup in Phase 4Q.

### New routes (server/routes/admin.ts — 20 endpoints under /api/admin/monitoring/)
- POST /snapshots/global — create global metrics snapshot
- POST /snapshots/tenant/:tenantId — create tenant metrics snapshot
- POST /snapshots/billing-period/:billingPeriodId — create billing period metrics snapshot
- GET /snapshots/global/latest — latest global snapshot
- GET /snapshots/tenant/:tenantId/latest — latest tenant snapshot
- GET /snapshots/billing-period/:billingPeriodId/latest — latest period snapshot
- POST /anomaly-scan — run all 6 detectors over a window
- GET /summary/invoices — invoice monitoring summary
- GET /summary/payments — payment monitoring summary
- GET /summary/subscriptions — subscription monitoring summary
- GET /summary/reconciliation — reconciliation monitoring summary
- GET /summary/allowances — allowance monitoring summary
- GET /summary/health/global — global monetization health
- GET /summary/health/tenant/:tenantId — tenant monetization health
- POST /alerts — upsert billing alert
- GET /alerts — list open alerts (optional severity filter)
- GET /alerts/scope/:scopeType/:scopeId — alerts by scope
- GET /alerts/:alertId/explain — explain alert
- POST /alerts/:alertId/acknowledge|resolve|suppress — status transitions
- GET /retention/policy — retention policy explanation
- GET /retention/failed-snapshots-older-than/:days — stale failed snapshots
- GET /retention/open-critical-alerts-older-than/:days — aged critical alerts
- GET /retention/monitoring-gaps — coverage gap detection
- GET /retention/tenants-without-recent-snapshots/:days — tenant coverage gaps

### Key design rules enforced
- Snapshots are observability artifacts — NOT accounting truth, never replace canonical tables
- Anomaly detection via alert_key deduplication — re-running over same window is idempotent
- No destructive cleanup in Phase 4Q — all retention helpers are inspection-only
- Failed snapshots persist as snapshot_status='failed' rows for operational forensics
- Phase 4C helpers (getBillingHealthSummary, getTenantBillingHealthSummary) preserved in billing-observability.ts

## Phase 4S — Billing Recovery & Integrity (branch: feature/billing-recovery-integrity)

### Schema additions
- **4R hardening (3 new columns):**
  - `billing_job_definitions.priority` (integer, not null, default 5, CHECK 1–10) — scheduling priority, lower = higher priority
  - `billing_job_definitions.job_duration_warning_ms` (integer, nullable, CHECK > 0) — slow-run warning threshold
  - `billing_job_runs.worker_id` (text, nullable) — distributed worker identifier for multi-node debugging
- **billing_recovery_runs** — durable audit log for billing recovery attempts. Fields: recovery_type (9 CHECK values), scope_type (6 values), status (started/completed/failed/skipped), trigger_type (manual/job/system), dry_run, result_summary JSONB. 4 CHECK constraints, 4 indexes
- **billing_recovery_actions** — detailed step log per recovery run. FK → billing_recovery_runs. Fields: action_type, target_table, target_id, action_status (planned/executed/skipped/failed), before_state/after_state/details JSONB. 1 CHECK, 3 indexes

### New lib files (4)
- `server/lib/ai/billing-integrity.ts` — read-only scan engine: ai_usage gaps, storage_usage gaps, snapshot drift (via period date range join), invoice arithmetic, stuck wallet debits. Also: runRepeatRecoveryFailureScan + runSnapshotRebuildHealthScan for job executors
- `server/lib/ai/billing-recovery.ts` — recovery/rebuild engine: preview + apply for billing_snapshot_rebuild and invoice_totals_rebuild. Preview is always read-only. Apply creates billing_recovery_runs + billing_recovery_actions rows
- `server/lib/ai/billing-recovery-summary.ts` — read-only explain/detail: getRecoveryRunDetail, listRecoveryRuns, explainRecoveryRun, getRecoveryRunStats
- `server/lib/ai/billing-recovery-retention.ts` — retention/inspection helpers: age report, action stats, retention candidates, stuck runs, daily trend. All read-only

### Extended: billing-jobs.ts (13 predefined jobs, was 10)
- billing_integrity_scan — category: audit, every 12h, priority 3, warningMs 240000
- snapshot_rebuild_health_scan — category: monitoring, every 24h, priority 5, warningMs 90000
- repeated_recovery_failure_scan — category: monitoring, every 6h, priority 4, warningMs 45000
- All 3 Phase 4S jobs: scan/detect only — never auto-repair

### New admin routes (14 endpoints under /api/admin/billing-recovery/)
- POST /scan — global/tenant/period integrity scan (read-only)
- POST /preview/snapshot-rebuild — dry-run snapshot rebuild preview
- POST /preview/invoice-totals-rebuild — dry-run invoice totals rebuild preview
- POST /apply/snapshot-rebuild — apply snapshot rebuild (idempotent)
- POST /apply/invoice-totals-rebuild — apply invoice totals rebuild (draft invoices only)
- GET /runs — list recovery runs (filterable)
- GET /runs/:runId — recovery run full detail with actions
- GET /runs/:runId/explain — structured human-readable explanation
- GET /runs/stats/summary — aggregate stats by type/status
- GET /retention/age-report — run age distribution
- GET /retention/action-stats — action counts by status/table
- GET /retention/candidates/:days — archival candidates (read-only)
- GET /retention/stuck-runs — runs stuck in 'started' beyond threshold
- GET /retention/daily-trend — per-day run counts

### Key design invariants
- Preview functions are ALWAYS read-only — never write to canonical billing tables
- Apply functions are idempotent — safe to re-run on same scope
- Finalized invoices are NEVER mutated — only draft invoices are touched by invoice_totals_rebuild
- ai_billing_usage has no billing_period_id FK — date-range join via billing_periods used for live aggregation
- All recovery_runs rows have dry_run flag — full audit trail of what was real vs preview

## Phase 4R — Automated Billing Operations (branch: feature/automated-billing-operations, commit: b3fab3d)

### New tables (2)
- **billing_job_definitions** — durable catalog of automated billing jobs. job_key unique, singleton_mode, schedule_type (manual/interval/cron), retry_limit, timeout_seconds. 5 CHECK constraints, 3 indexes (pkey, bjd_job_key_unique, bjd_status_created_idx, bjd_category_created_idx)
- **billing_job_runs** — durable execution log. FK to billing_job_definitions, run_status lifecycle (started/completed/failed/timed_out/skipped), lock_acquired, result_summary JSONB, attempt_number. 5 CHECK constraints, 5 indexes

### New lib files (6)
- `server/lib/ai/billing-job-locks.ts` — distributed locking via pg_try_advisory_xact_lock + started-row singleton guard
- `server/lib/ai/billing-operations.ts` — central job engine, run lifecycle (start/complete/fail/skip), retry logic with attempt_number increment, job executor registry
- `server/lib/ai/billing-jobs.ts` — 10 predefined job definitions + executor registrations wired to existing safe engines
- `server/lib/ai/billing-job-health.ts` — health summary, stale run detection, failed job preview, job state explanation
- `server/lib/ai/billing-scheduler.ts` — interval-based scheduler, due-job detection, scheduler trigger entrypoint
- `server/lib/ai/billing-ops-retention.ts` — inspection helpers (completed/failed/timed-out runs preview, definitions without runs, duplicate started runs). Read-only, no cleanup

### New admin routes (17 endpoints under /api/admin/billing-ops/)
- GET /jobs, POST /jobs/seed, POST /jobs/:jobKey/run
- GET /runs, GET /runs/:runId, POST /runs/:runId/retry
- GET /health
- GET /inspections/stale-runs, GET /inspections/failed-runs/:days
- POST /scheduler/trigger, GET /scheduler/status
- GET /retention/policy, /completed-runs/:days, /failed-runs/:days, /timed-out-runs/:days, /definitions-without-runs, /duplicate-started-runs

### Key design rules enforced
- Singleton enforcement via pg advisory lock (Layer 1) + started-row check (Layer 2)
- Lock check happens BEFORE run row creation — prevents self-blocking
- Retry runs increment attempt_number and record retriedFromRunId in metadata
- All execution goes through runBillingJob — no bypass
- Scheduler only triggers interval jobs — manual/cron jobs never auto-triggered
- No in-memory locks — all state in billing_job_runs
- No destructive cleanup in Phase 4R — retention helpers are inspection-only

## Phase 5A — Document Registry & Storage Foundation (branch: feature/document-registry-foundation)

### New tables (8) — total schema: 85 tables

- **knowledge_bases** — tenant-isolated knowledge base registry. slug (NOT NULL, unique per tenant), lifecycle_state, visibility, default_retrieval_k, metadata. 5 indexes
- **knowledge_documents** — enterprise document registry replacing legacy stub. knowledge_base_id FK, title, source_type, document_type, lifecycle_state, document_status, current_version_id (NO FK — circular; enforced at service layer), latest_version_number, tags JSONB, soft-delete via deleted_at. 6 indexes
- **knowledge_document_versions** — immutable version chain per document. version_number, version_status, is_current flag, content_checksum, mime_type, file_size_bytes, language_code, processing timestamps. 4 indexes
- **knowledge_storage_objects** — storage backend objects scoped to a document version. storage_provider, bucket_name, object_key (NOT NULL), upload_status, checksum, soft-delete via deleted_at. 4 indexes
- **knowledge_processing_jobs** — async processing job queue. job_type, status lifecycle (pending/running/completed/failed/retrying/cancelled), priority, attempt_count, max_attempts, idempotency_key (UNIQUE), worker_id, payload/result_summary JSONB. 5 indexes
- **knowledge_chunks** — text chunks derived from a document version. chunk_key (NOT NULL, content-addressable), chunk_index, source_page/character ranges, token_estimate, chunk_hash, chunk_active. 5 indexes
- **knowledge_embeddings** — embedding metadata per chunk. embedding_provider (NOT NULL), embedding_model (NOT NULL), vector_backend, vector_status, vector_namespace, vector_reference, dimensions, content_hash, indexed_at. 5 indexes
- **knowledge_index_state** — per-document-version index state tracker. knowledge_document_id + knowledge_document_version_id both NOT NULL, index_state, chunk_count, indexed_chunk_count, embedding_count, last_indexed_at, stale_reason. 4 indexes

### New lib files (4)
- `server/lib/ai/vector-adapter.ts` — abstract VectorAdapter interface + PgVectorAdapter stub + getVectorAdapter() factory
- `server/lib/ai/knowledge-bases.ts` — KB CRUD: createKnowledgeBase, getKnowledgeBase, listKnowledgeBases, updateKnowledgeBase, archiveKnowledgeBase
- `server/lib/ai/knowledge-documents.ts` — document lifecycle: createDocument, getDocument, listDocuments, setCurrentDocumentVersion, softDeleteDocument, getDocumentWithVersion
- `server/lib/ai/knowledge-processing.ts` — processing pipeline: createProcessingJob, claimProcessingJob, completeProcessingJob, failProcessingJob, retryProcessingJob, getJobStatus, getProcessingQueue

### Updated repository
- `server/repositories/knowledge.repository.ts` — extended with Phase 5A type exports and insert schemas for all 8 tables

### New admin routes (20 endpoints)
- /api/admin/knowledge/bases — GET list, POST create
- /api/admin/knowledge/bases/:id — GET detail, PATCH update, DELETE archive
- /api/admin/knowledge/bases/:id/documents — GET list, POST create
- /api/admin/knowledge/bases/:id/documents/:docId — GET detail, DELETE soft-delete
- /api/admin/knowledge/bases/:id/documents/:docId/versions — GET list versions
- /api/admin/knowledge/bases/:id/documents/:docId/versions/:verId/set-current — POST set current
- /api/admin/knowledge/processing/jobs — GET list
- /api/admin/knowledge/processing/jobs/:jobId — GET detail
- /api/admin/knowledge/processing/jobs/:jobId/claim — POST claim (worker)
- /api/admin/knowledge/processing/jobs/:jobId/complete — POST complete
- /api/admin/knowledge/processing/jobs/:jobId/fail — POST fail
- /api/admin/knowledge/processing/jobs/:jobId/retry — POST retry
- /api/admin/knowledge/bases/:id/chunks — GET list chunks for KB
- /api/admin/knowledge/bases/:id/embeddings — GET list embeddings for KB

### Key design invariants
- knowledge_documents.current_version_id has NO FK — circular dependency; setCurrentDocumentVersion() enforces validity at service layer
- knowledge_index_state.knowledge_document_id is NOT NULL — state always scoped to a document, not just KB
- chunk_key is NOT NULL — content-addressable identifier set at ingestion time
- embedding_provider + embedding_model are NOT NULL — required for cost attribution and re-indexing
- knowledge_bases.slug is NOT NULL — URL-safe tenant-unique identifier
- Old enums knowledge_source_type / knowledge_status kept in schema for backward compatibility (no longer used by any table column)
- All 14 validation scenarios passed

### Migration notes
- Old stub knowledge_documents table and its legacy enums (knowledge_source_type, knowledge_status) were dropped via raw SQL before drizzle-kit push — no data loss (stub only)
- Duplicate insertKnowledgeDocumentSchema export removed from shared/schema.ts (old legacy export at line ~1137)

## Phase 5B — Document Parsing & Chunking Pipeline (branch: feature/document-parsing-chunking)

### Schema extensions (raw SQL migrations applied)

**knowledge_document_versions** — 8 new columns:
- `parser_name`, `parser_version` — which parser ran
- `parse_status` (CHECK: pending/running/completed/failed), `parse_started_at`, `parse_completed_at`
- `parsed_text_checksum` — SHA-256 hex of normalized parsed text (dedup guard)
- `normalized_character_count` (CHECK ≥ 0)
- `parse_failure_reason` — explicit error message when parse fails

**knowledge_processing_jobs** — 4 new columns:
- `processor_name`, `processor_version` — identifies which processing implementation ran
- `locked_at` — when job was acquired/locked (race-safe acquire)
- `heartbeat_at` — last worker heartbeat timestamp

**knowledge_chunks** — 7 new columns:
- `chunk_strategy`, `chunk_version` — strategy name + version for deterministic rebuilds
- `overlap_characters` (CHECK ≥ 0) — actual overlap used for this chunk
- `source_heading_path`, `source_section_label` — structural context from parsed document
- `replaced_at`, `replaced_by_job_id` — audit trail for chunk replacement

**Partial unique indexes on knowledge_chunks** (replacing old global uniques):
- `kc_version_chunk_index_active_unique`: (knowledge_document_version_id, chunk_index) WHERE chunk_active = true
- `kc_version_chunk_key_active_unique`: (knowledge_document_version_id, chunk_key) WHERE chunk_active = true

These allow safe chunk replacement: deactivate old chunks (chunk_active=false), insert new ones with same key.

### New lib files (2)

**`server/lib/ai/document-parsers.ts`**
- `DocumentParser` interface + `ParseResult` type
- Format parsers: `TextParser`, `MarkdownParser`, `HtmlParser`, `JsonParser`, `CsvParser`
- Explicit failure for unsupported formats: PDF/DOCX/binary throw `KnowledgeInvariantError` (INV-P9)
- `getParserForMimeType(mime)` factory returns correct parser or throws
- Each parser normalizes text, removes HTML tags, flattens JSON/CSV, normalizes whitespace

**`server/lib/ai/document-chunking.ts`**
- `buildChunkKey(docId, verId, idx, strategy, version)` — deterministic, stable key
- `buildChunkHash(text, strategy, version)` — SHA-256 of content+strategy+version
- `ChunkingConfig` type: maxCharacters (default 800), overlapCharacters (default 100), strategy, version
- `chunkParsedDocument(text, docId, verId, config)` → `ChunkCandidate[]`
- Strategy: paragraph_window — split on double-newlines, enforce maxCharacters, slide overlap

### Extended lib: `server/lib/ai/knowledge-processing.ts`

**New/extended functions:**
- `runParseForDocumentVersion(verId, tenantId, {content})` — full parse lifecycle: acquire job, run parser, record metadata, mark parse_status=completed/failed
- `runChunkingForDocumentVersion(verId, tenantId, {content, chunkingConfig?})` — full chunk lifecycle: acquire job, deactivate prior active chunks, insert new chunks, upsert index_state to pending/stale
- `acquireKnowledgeProcessingJob(jobId, tenantId, {workerId?})` — CAS acquire (queued→running via UPDATE...RETURNING), race-safe — second acquire returns null
- `isVersionRetrievable(verId, tenantId)` — checks KB active, doc active, version is_current, index_state=indexed
- `explainDocumentVersionParseState(verId, tenantId)` — returns parseStatus, parser, checksum, charCount
- `explainDocumentVersionChunkState(verId, tenantId)` — returns activeChunkCount, strategy, index_state
- `previewChunkReplacement(verId, tenantId, config)` — read-only preview: how many chunks would change
- `listDocumentProcessingJobs(docId, tenantId)` — list all jobs for a document across all versions

### New admin routes (~20 endpoints) in `server/routes/admin.ts`

- POST `/api/admin/knowledge/parse/versions/:verId` — trigger parse for a version
- POST `/api/admin/knowledge/chunk/versions/:verId` — trigger chunking for a version
- GET `/api/admin/knowledge/jobs/:jobId` — job detail
- POST `/api/admin/knowledge/jobs/:jobId/acquire` — acquire job (worker endpoint)
- GET `/api/admin/knowledge/versions/:verId/parse-state` — parse state explanation
- GET `/api/admin/knowledge/versions/:verId/chunk-state` — chunk state explanation
- GET `/api/admin/knowledge/versions/:verId/chunk-preview` — preview chunk replacement
- GET `/api/admin/knowledge/versions/:verId/retrievable` — retrievability check
- GET `/api/admin/knowledge/documents/:docId/processing-jobs` — list all jobs for document

### Invariants enforced (INV-P1 through INV-P10)

- INV-P1: Version must exist and belong to tenant before any processing
- INV-P2: Document must exist and belong to tenant
- INV-P3: Chunking NEVER sets index_state='indexed' — only 'pending' or 'stale'
- INV-P4: Archived KB or archived document blocks all processing
- INV-P5: parse_status transitions are strictly: null → pending → running → completed/failed
- INV-P6: Chunk replacement is atomic — old chunks deactivated before new inserted
- INV-P7: replacedByJobId must reference a real job row
- INV-P8: Job acquire uses CAS (compare-and-swap on status=queued) — prevents double-acquire
- INV-P9: Unsupported mime types (PDF, DOCX, binary) fail explicitly — no silent fallback
- INV-P10: Cross-tenant access raises KnowledgeInvariantError immediately

### Validation: 14/14 scenarios passed

S1 parse supported text/markdown, S2 parse unsupported format (PDF) fails explicitly, S3 chunk parsed version (indexState=pending, NOT indexed), S4 rerun chunking deactivates prior chunks (audit trail), S5 parse failure doesn't mutate current version, S6 chunk rebuild transactionally safe (no mixed state), S7 non-current version chunking doesn't affect current, S8 cross-tenant linkage rejected, S9 archived KB/doc blocks processing, S10 deterministic chunk keys and hashes, S11 changed chunk config causes stale transition, S12 job lock safety (second acquire rejected), S13 inspection helpers work, S14 Phase 5A invariants still hold.

### DB verification confirmed

- All 8 parse columns on knowledge_document_versions present
- All 4 lock/heartbeat columns on knowledge_processing_jobs present
- All 7 chunk rebuild columns on knowledge_chunks present
- Both partial unique indexes (WHERE chunk_active=true) verified in pg_indexes
- All 3 CHECK constraints verified in pg_constraint
- Real rows confirmed: parsed versions with parser metadata, chunks with strategy/overlap/replacement audit trail, processing jobs with processor_name/locked_at

## Phase 5B.1 — Structured Document Processing (branch: feature/structured-document-processing)

CSV/TSV structured parse pipeline with `table_rows` chunking strategy. 21 columns added to 3 tables.

### New files

- `server/lib/ai/structured-document-parsers.ts` — CSV parser (RFC-4180, quoted fields), TSV parser (tab delimited reuse), XLSX explicit fail (INV-SP11), `selectStructuredDocumentParser()` factory, `parseStructuredDocumentVersion()`, `normalizeStructuredDocument()`, `computeStructuredContentChecksum()`
- `server/lib/ai/structured-document-chunking.ts` — `table_rows` strategy, `buildStructuredChunkKey()`, `buildStructuredChunkHash()`, `normalizeStructuredChunkText()`, `chunkStructuredDocument()` with sheet boundary preservation and row windowing, `summarizeStructuredChunks()`
- `server/lib/ai/migrate-phase5b1.ts` — raw SQL migration for 21 new DB columns, CHECK constraints, indexes
- `server/lib/ai/validate-phase5b1.ts` — 16 validation scenarios (all passing)

### Extended files

- `server/lib/ai/knowledge-processing.ts` — `runStructuredParseForDocumentVersion`, `runStructuredChunkingForDocumentVersion`, `markStructuredParseFailed/Completed`, `explainStructuredParseState/ChunkState`, `previewStructuredChunkReplacement`, `listStructuredProcessingJobs`, `summarizeStructuredChunkingResult`, `syncIndexStateAfterStructuredChunking`, `markIndexStateStaleAfterStructuredChunkReplace`
- `server/routes/admin.ts` — 14 new endpoints under `/api/admin/knowledge/structured/`

### DB schema additions

- `knowledge_document_versions`: +12 columns (`structured_parse_status`, `structured_parse_job_id`, `structured_parse_started_at`, `structured_parse_completed_at`, `structured_parse_failed_at`, `structured_parse_error`, `sheet_count`, `row_count`, `column_count`, `raw_structured_content`, `structured_content_checksum`, `structured_parse_options`)
- `knowledge_chunks`: +9 columns (`table_chunk`, `sheet_name`, `row_start`, `row_end`, `table_chunk_key`, `table_chunk_hash`, `table_chunk_strategy`, `table_chunk_strategy_version`, `replaced_by_job_id`)
- `knowledge_processing_jobs`: +2 columns (`structured_processor_name`, `structured_processor_version`); job_type CHECK updated to include `structured_parse` and `structured_chunk`

### Invariants enforced (INV-SP1 through INV-SP11)

- INV-SP1: Version must exist and belong to tenant
- INV-SP2: Document must exist and belong to tenant
- INV-SP3: Structured chunking requires `structured_parse_status='completed'`
- INV-SP4: Structured chunking NEVER sets `index_state='indexed'` — only 'pending' or 'stale'
- INV-SP5: Archived KB or document blocks all structured processing
- INV-SP6: Chunk replacement is atomic — old table_chunks deactivated before new inserted
- INV-SP7: replacedByJobId must reference a real job row
- INV-SP8: Job acquire uses CAS — prevents double-acquire
- INV-SP9: Cross-tenant access raises KnowledgeInvariantError immediately
- INV-SP10: parse_status transitions: null → running → completed/failed
- INV-SP11: XLSX and unknown mime types fail explicitly — no silent fallback

### Validation: 16/16 scenarios passed

S1 CSV parse (sheetCount=1 rowCount=5), S2 TSV parse (rowCount=3 cols=3), S3 XLSX explicit fail, S4 unsupported mime explicit fail, S5 chunk parsed version (indexState=pending NOT indexed), S6 chunk rebuild deactivates prior chunks (audit trail), S7 parse fail doesn't mutate current retrieval, S8 chunk transaction safe (no mixed state), S9 non-current version no affect on current, S10 cross-tenant rejected, S11 archived KB/doc blocked, S12 deterministic chunk keys and hashes, S13 changed config causes stale+replacement, S14 job lock safety (second acquire rejected), S15 inspection helpers work, S16 Phase 5A.1 invariants still hold.

## Phase 5B.2 — Image Ingestion & OCR Pipeline (branch: feature/image-ingestion-ocr)

OCR parser abstraction + image-aware chunking. 22 columns added across 3 tables.

### New files

- `server/lib/ai/image-ocr-parsers.ts` — `selectOcrParser()`, `parseImageDocumentVersion()`, `normalizeOcrDocument()`, `computeOcrTextChecksum()`, `summarizeOcrParseResult()`. stub_ocr v1.0 engine (deterministic placeholder). Supported: image/png, image/jpeg, image/webp. Explicit fail for unsupported + oversized (INV-IMG11).
- `server/lib/ai/image-ocr-chunking.ts` — `ocr_regions` strategy, `buildOcrChunkKey()`, `buildOcrChunkHash()`, `normalizeOcrChunkText()`, `chunkOcrDocument()` with region windowing + bbox merging + page context, `summarizeOcrChunks()`
- `server/lib/ai/migrate-phase5b2.ts` — raw SQL migration for 22 new DB columns, CHECK constraints, indexes
- `server/lib/ai/validate-phase5b2.ts` — 15 validation scenarios (all passing)

### Extended files

- `server/lib/ai/knowledge-processing.ts` — `runOcrParseForDocumentVersion`, `runOcrChunkingForDocumentVersion`, `markOcrParseFailed/Completed`, `explainOcrParseState/ChunkState`, `previewOcrChunkReplacement`, `listOcrProcessingJobs`, `summarizeOcrChunkingResult`, `syncIndexStateAfterOcrChunking`, `markIndexStateStaleAfterOcrChunkReplace`
- `shared/schema.ts` — 10 OCR columns on knowledge_document_versions, 10 image chunk columns on knowledge_chunks, 2 OCR processor columns on knowledge_processing_jobs
- `server/routes/admin.ts` — 12 new endpoints under `/api/admin/knowledge/image-ocr/`

### DB schema additions

- `knowledge_document_versions`: +10 columns (`ocr_status`, `ocr_started_at`, `ocr_completed_at`, `ocr_engine_name`, `ocr_engine_version`, `ocr_text_checksum`, `ocr_block_count`, `ocr_line_count`, `ocr_average_confidence`, `ocr_failure_reason`)
- `knowledge_chunks`: +10 columns (`image_chunk`, `image_chunk_strategy`, `image_chunk_version`, `image_region_index`, `bbox_left`, `bbox_top`, `bbox_width`, `bbox_height`, `ocr_confidence`, `source_page_number`)
- `knowledge_processing_jobs`: +2 columns (`ocr_processor_name`, `ocr_processor_version`); job_type CHECK updated to include `ocr_parse` and `ocr_chunk`

### Invariants enforced (INV-IMG1 through INV-IMG12)

- INV-IMG1: Version must exist and belong to tenant
- INV-IMG2: OCR chunking runs only on the explicitly requested version
- INV-IMG3: OCR chunking requires ocrStatus='completed' or explicit content
- INV-IMG4: OCR chunking NEVER sets index_state='indexed'
- INV-IMG5: Archived/inactive KB or document blocks all OCR processing
- INV-IMG6: Parse failure does NOT clear valid historical chunks
- INV-IMG7: Failed chunk rebuild leaves no partial active chunk corruption (transactional)
- INV-IMG8: Non-current version OCR processing does not alter current retrieval state
- INV-IMG9: Cross-tenant linkage rejected in all OCR paths
- INV-IMG10: OCR chunk keys and hashes are deterministic for same input + strategy/version
- INV-IMG11: Unsupported, oversized, or malformed image inputs fail explicitly — no silent fallback
- INV-IMG12: document_status='ready' still requires valid current version + index_state='indexed'

### Validation: 15/15 scenarios passed

S1 PNG OCR parse (blocks=3 lines=7 checksum ok), S2 unsupported mime explicit fail (INV-IMG11), S3 oversized image safe rejection, S4 chunk parsed version (indexState=pending NOT indexed), S5 rerun deactivates prior image chunks (audit trail), S6 parse fail doesn't mutate current retrieval, S7 chunk transaction safe (no mixed state), S8 non-current version no affect on current, S9 cross-tenant rejected, S10 archived KB/doc blocked, S11 deterministic OCR chunk keys and hashes, S12 changed config causes replacement+stale, S13 job lock safety (w2 rejected), S14 inspection helpers work (ocrStatus/chunks/jobs), S15 Phase 5A.1 invariants still hold.

## Phase 5B.2.1 — OCR Engine Integration Hardening (branch: feature/ocr-engine-hardening)

Replaces stub_ocr v1.0 with real production OCR engine (openai_vision_ocr v1.0).

### New files

- `server/lib/ai/openai-vision-ocr.ts` — `openaiVisionOcrEngine` (real OCR via GPT-4o Vision API). Content routing: data URL / raw base64 / HTTPS URL → OpenAI Vision API call; plain text → text-based extraction (backward compat). Virtual 1000×1000 canvas coordinate mapping for bounding boxes. 30s timeout + explicit failure.
- `server/lib/ai/validate-phase5b2-1.ts` — 15 validation scenarios (all passing)

### Updated files

- `server/lib/ai/image-ocr-parsers.ts` — `selectOcrParser()` now routes all supported mime types to `openaiVisionOcrEngine`. Engine hint `'stub_ocr'` overrides to legacy stub for isolated testing. `normalizeOcrDocument()` now always recomputes `textChecksum` after sort. `stubOcrEngine` kept and exported for unit testing only.

### Engine properties (openai_vision_ocr v1.0)

- Model: gpt-4o (vision mode, detail=high, temperature=0, max_tokens=4096)
- Supported: image/png, image/jpeg, image/jpg, image/webp
- Content detection: data URL → API; raw base64 → API; HTTPS URL → API; plain text → text fallback
- Bounding boxes: percentage-based from GPT-4o → scaled to virtual 1000×1000 canvas integers
- Confidence: per-region float 0.0–1.0 from model (0.85–0.99 clear, 0.65–0.85 unclear)
- Checksum: SHA-256 of sorted region texts (page|regionIndex|text), hex slice 24 chars
- Explicit failure: oversized (INV-IMG11), empty (INV-IMG11), no-text image (INV-IMG11), OPENAI_API_KEY missing + binary content (INV-IMG11)

### Backward compatibility

- All existing Phase 5B.2 validation scenarios pass (15/15) with new engine
- Tests injecting plain text still work via text fallback path (labeled in warnings)
- `engineHint: 'stub_ocr'` in `OcrParseOptions` routes to legacy engine for isolated tests

### Validation: 15/15 scenarios passed

S1 selectOcrParser routes to openai_vision_ocr for all supported mime types, S2 stub_ocr hint override works, S3 engine properties correct (name/version/types/parse), S4 plain text fallback path produces correct output, S5 normalizeOcrDocument sets textChecksum correctly, S6 computeOcrTextChecksum is deterministic, S7 summarizeOcrParseResult includes engine name, S8 oversized content explicit rejection (INV-IMG11), S9 empty content explicit rejection (INV-IMG11), S10 5/5 unsupported mime types fail explicitly, S11 parseImageDocumentVersion returns full engine info, S12 engineHint=stub_ocr routes to legacy engine, S13 bounding boxes present and valid for plain text path, S14 OCR result integrates with chunkOcrDocument correctly, S15 image/jpg and image/jpeg both supported.

## Phase 5B.3 — Audio/Video Ingestion Pipeline (branch: feature/audio-video-ingestion)

### Purpose
Transcript ingestion pipeline for audio files via OpenAI Whisper API. Video explicitly blocked (INV-MEDIA2). Parallel structure to Phase 5B.2 (OCR).

### New files
- `server/lib/ai/media-transcript-parsers.ts` — parser abstraction, SUPPORTED_AUDIO_MIME_TYPES, SUPPORTED_VIDEO_MIME_TYPES, INV-MEDIA1/2 invariants, stub_transcript engine, selectMediaTranscriptParser, parseMediaDocumentVersion
- `server/lib/ai/openai-whisper-transcription.ts` — real Whisper API engine (whisper-1), verbose_json + segment timestamps, plain text fallback for tests, INV-MEDIA1 explicit rejections
- `server/lib/ai/media-transcript-chunking.ts` — time_windows chunking strategy, deterministic chunkKey/chunkHash (INV-MEDIA10), speaker grouping, summarizeTranscriptChunks
- `server/lib/ai/migrate-phase5b3.ts` — raw SQL migration (ran successfully)
- `server/lib/ai/validate-phase5b3.ts` — 15 validation scenarios, 32/32 assertions passed

### DB changes (23 new items)
- `knowledge_document_versions`: 12 transcript columns (transcript_status, transcript_started_at, transcript_completed_at, transcript_engine_name, transcript_engine_version, transcript_text_checksum, transcript_segment_count, transcript_speaker_count, transcript_language_code, transcript_average_confidence, media_duration_ms, transcript_failure_reason) + 5 CHECK constraints
- `knowledge_chunks`: 9 transcript chunk columns (transcript_chunk, transcript_chunk_strategy, transcript_chunk_version, segment_start_ms, segment_end_ms, transcript_segment_index, speaker_label, transcript_confidence, source_track) + 5 CHECK constraints
- `knowledge_processing_jobs`: 2 transcript processor columns (transcript_processor_name, transcript_processor_version) + job_type CHECK updated (transcript_parse, transcript_chunk)
- Indexes: kdv_tenant_transcript_status_idx, idx_kchk_transcript_chunk

### knowledge-processing.ts additions
12 exported functions: runTranscriptParseForDocumentVersion, markTranscriptParseFailed, markTranscriptParseCompleted, runTranscriptChunkingForDocumentVersion, syncIndexStateAfterTranscriptChunking, markIndexStateStaleAfterTranscriptChunkReplace, explainTranscriptParseState, explainTranscriptChunkState, previewTranscriptChunkReplacement, listTranscriptProcessingJobs, summarizeTranscriptChunkingResult + 4 new interfaces

### Admin routes (14 endpoints under /api/admin/knowledge/media-transcript/)
parse/run, parse/mark-failed, parse/mark-completed, parse/explain/:versionId, chunk/run, chunk/explain/:versionId, chunk/preview-replacement/:versionId, chunk/list/:versionId, jobs/document/:documentId, jobs/:jobId/summarize, index-state/sync, index-state/mark-stale + versions/:versionId/transcript-parse-state + versions/:versionId/transcript-chunk-state

### Invariants enforced
- INV-MEDIA1: Explicit failure for unsupported mime, oversized, empty, no-API-key+binary
- INV-MEDIA2: Video transcription blocked (requires ffmpeg not wired)
- INV-MEDIA3: Transcript chunking requires transcriptStatus='completed' or explicit content
- INV-MEDIA4: Transcript chunking NEVER sets index_state='indexed'
- INV-MEDIA10: Chunk keys and hashes are deterministic

### Validation: 32/32 assertions passed (15 scenarios)
S1 kdv transcript columns (12), S2 kc transcript chunk columns (9), S3 kpj processor columns (2), S4 job_type CHECK constraints, S5 SUPPORTED_AUDIO_MIME_TYPES (4 types), S6 SUPPORTED_VIDEO_MIME_TYPES (video/mp4, webm, quicktime), S7 video/mp4 rejects with INV-MEDIA2, S8 text/csv rejects with INV-MEDIA1, S9 default engine=openai_whisper_transcription (plain text fallback path), S10 normalizeTranscriptDocument recomputes checksum, S11 summarizeTranscriptParseResult format, S12 chunkTranscriptDocument time_windows strategy + deterministic keys/hashes, S13 buildTranscriptChunkKey determinism (INV-MEDIA10), S14 normalizeTranscriptChunkText collapses whitespace, S15 summarizeTranscriptChunks format.

## Phase 5B.4 — Email / HTML / Imported Content Ingestion (branch: feature/email-html-ingestion)

### Purpose
Import content ingestion pipeline for email (RFC 822/thread), HTML (heading-aware sections), and plain text imports. Parallel structure to Phase 5B.2 (OCR) and 5B.3 (Transcript). No external library dependencies — pure regex-based parsing.

### New files
- `server/lib/ai/import-content-parsers.ts` — parser abstraction, SUPPORTED_IMPORT_MIME_TYPES, htmlImportParser (heading-aware sectioning, link counting, tag stripping), emailImportParser (RFC 822 header extraction, quoted content separation, thread splitting), textImportParser (paragraph blocking), selectImportContentParser, parseImportedDocumentVersion, normalizeImportedDocument, computeImportTextChecksum, summarizeImportParseResult
- `server/lib/ai/import-content-chunking.ts` — email_messages / html_sections / import_text_blocks strategies, deterministic chunkKey/chunkHash (INV-IMP10), normalizeImportChunkText, summarizeImportChunks
- `server/lib/ai/migrate-phase5b4.ts` — raw SQL migration (ran successfully)
- `server/lib/ai/validate-phase5b4.ts` — 16 validation scenarios, 54/54 assertions passed

### DB changes (25 new items)
- `knowledge_document_versions`: 12 import parse columns (import_content_type, import_parse_status, import_parse_started_at, import_parse_completed_at, import_parser_name, import_parser_version, import_text_checksum, import_message_count, import_section_count, import_link_count, import_failure_reason, source_language_code) + CHECK constraints
- `knowledge_chunks`: 11 import chunk columns (email_chunk, html_chunk, import_chunk_strategy, import_chunk_version, message_index, thread_position, section_label, source_url, sender_label, sent_at, quoted_content_included) + CHECK constraints
- `knowledge_processing_jobs`: 2 import processor columns (import_processor_name, import_processor_version) + job_type CHECK updated (import_parse, import_chunk)

### knowledge-processing.ts additions (12 functions + 4 interfaces)
RunImportParseOptions, ImportParseExecutionResult, RunImportChunkingOptions, ImportChunkingExecutionResult (interfaces)
runImportParseForDocumentVersion, markImportParseFailed, markImportParseCompleted, runImportChunkingForDocumentVersion, syncIndexStateAfterImportChunking, markIndexStateStaleAfterImportChunkReplace, explainImportParseState, explainImportChunkState, previewImportChunkReplacement, listImportProcessingJobs, summarizeImportChunkingResult (functions)

### Admin routes (14 endpoints under /api/admin/knowledge/import-content/)
parse/run, parse/mark-failed, parse/mark-completed, parse/explain/:versionId, chunk/run, chunk/explain/:versionId, chunk/preview-replacement/:versionId, jobs/document/:documentId, jobs/:jobId/summarize, index-state/sync, index-state/mark-stale + versions/:versionId/import-parse-state + versions/:versionId/import-chunk-state

### Invariants enforced
- INV-IMP1: Version→document→KB chain + tenant validation required
- INV-IMP2: Only the explicitly requested version is processed
- INV-IMP3: Import chunking requires importParseStatus='completed' or explicit content
- INV-IMP4: Import chunking NEVER sets index_state='indexed'
- INV-IMP7: Failed chunk rebuild uses transactions to prevent partial active chunk corruption
- INV-IMP8: Non-current version processing does not alter current retrieval state
- INV-IMP10: Chunk keys and hashes are deterministic
- INV-IMP11: Explicit failure for unsupported/malformed/empty/unsafe content
- INV-IMP12: Does NOT mark document_status='ready'

### Validation: 54/54 assertions passed (16 scenarios)
S1 kdv import columns (12), S2 kc import chunk columns (11), S3 kpj processor columns (2), S4 job_type CHECK constraints (import_parse + import_chunk), S5 SUPPORTED mime type sets, S6 HTML parser parses headings into sections, S7 Email parser extracts RFC 822 headers + messages, S8 Plain text import parser produces paragraph sections, S9 Unsupported mime type rejected explicitly (INV-IMP11), S10 Empty content rejected explicitly (INV-IMP11), S11 HTML chunking html_sections strategy + deterministic keys/hashes, S12 Email chunking email_messages strategy preserves message context, S13 buildImportChunkKey determinism (INV-IMP10), S14 normalizeImportChunkText collapses whitespace, S15 normalizeImportedDocument sorts + recomputes checksum, S16 summarizeImportParseResult + summarizeImportChunks output format.

## Phase 5C — Embedding Pipeline & Vector Preparation (branch: feature/embedding-pipeline)

### Purpose
Transform knowledge_chunks into vector embeddings for semantic retrieval. Job-driven, batch-capable, deterministic, retry-safe, tenant-safe. pgvector enabled. Vectors stored as real[] (Phase 5D will add HNSW index).

### New files
- `server/lib/ai/embedding-providers.ts` — EmbeddingProvider interface, OpenAI text-embedding-3-small (1536-dim, default), OpenAI text-embedding-3-large (3072-dim), stub_embedding (deterministic, no API call), selectEmbeddingProvider(), splitIntoBatches(), normalizeEmbeddingVector(), computeEmbeddingContentHash(), summarizeEmbeddingCost()
- `server/lib/ai/embedding-processing.ts` — runEmbeddingForDocumentVersion() (5-step pipeline: validate→fetch chunks→create job→batch→persist), retryEmbeddingForDocumentVersion(), explainEmbeddingState(), listEmbeddingJobs(), summarizeEmbeddingResult(), listEmbeddingsForDocument()
- `server/lib/ai/migrate-phase5c.ts` — raw SQL migration (ran successfully, pgvector enabled)
- `server/lib/ai/validate-phase5c.ts` — 10 validation scenarios, 46/46 assertions passed

### DB changes (10 new items + pgvector)
- `pgvector` extension: enabled (`CREATE EXTENSION IF NOT EXISTS vector`)
- `knowledge_embeddings`: 6 new columns (embedding_status CHECK('pending','running','completed','failed'), embedding_vector real[], embedding_dimensions, token_usage, estimated_cost_usd, updated_at) + CHECK constraints + ke_tenant_embedding_status_idx
- `knowledge_processing_jobs`: 4 new columns (embedding_provider, embedding_model, token_usage, estimated_cost_usd) + job_type CHECK updated (embedding_generate, embedding_retry)
- `shared/schema.ts`: `real` imported from drizzle-orm/pg-core

### Admin routes (7 endpoints under /api/admin/knowledge/embeddings/)
run, retry, state/:versionId, jobs/document/:documentId, jobs/:jobId/summarize, document/:documentId, versions/:versionId/embedding-state

### Invariants enforced
- INV-EMB1: Tenant isolation — cross-tenant access fails explicitly
- INV-EMB2: Only active KB documents are processed
- INV-EMB3: Re-running replaces all prior embeddings transactionally (INV-EMB7)
- INV-EMB4: NEVER sets index_state='indexed'
- INV-EMB5: Each batch records provider, model, token_usage, estimated_cost_usd
- INV-EMB6: Empty chunk set fails explicitly
- INV-EMB7: Embedding replacement is transactional — no partial state
- INV-EMB8: embedding_count reflects completed embeddings only

### Validation: 46/46 assertions passed (10 scenarios)
S1 ke new columns (6), S2 kpj embedding columns (4), S3 job_type CHECK (embedding_generate+retry), S4 provider abstraction (openai_small/large/stub routing + unknown provider throws), S5 stub provider determinism (1536-dim vectors, same text → same vector), S6 embed 5 chunks → 5 DB rows with vectors in DB, S7 embedding_count updated + index_state NOT 'indexed' (INV-EMB4), S8 deterministic replacement (5 prior deactivated + 5 new created) INV-EMB3/7, S9 cross-tenant rejected INV-EMB1, S10 batch size handling + splitIntoBatches utility.

## Phase 5D — Vector Search Engine (branch: feature/vector-search-engine)

### Purpose
Enterprise-safe semantic vector search over knowledge embeddings. Strict tenant isolation, current-version safety, lifecycle+index-state filtering, deterministic ranking, search observability. pgvector-backed. Zero raw pgvector SQL in application logic.

### New files
- `server/lib/ai/vector-search-provider.ts` — pgvector search provider: searchPgvector() (3 metric variants: cosine/l2/inner_product), checkChunkExclusion(), explainPgvectorSearch(), normalizeSimilarityScore(), buildVectorSearchFilterSummary(), computeQueryHash(). All pgvector SQL isolated here.
- `server/lib/ai/vector-search.ts` — Application-level execution flow: runVectorSearch() (7-step pipeline), explainVectorSearch(), previewRetrievalSafeFilterSet(), explainWhyChunkWasReturned(), explainWhyChunkWasExcluded(), summarizeVectorSearchRun(), listVectorSearchCandidates(), VectorSearchInvariantError
- `server/lib/ai/migrate-phase5d.ts` — Raw SQL migration (ran successfully)
- `server/lib/ai/validate-phase5d.ts` — 15 scenarios, 62/62 assertions passed

### Modified files
- `shared/schema.ts` — doublePrecision added to imports; knowledge_embeddings: +is_active (bool not null default true) + similarity_metric (text, CHECK IN cosine/l2/inner_product) + ke_similarity_metric_check + ke_tenant_is_active_idx; new tables: knowledgeSearchRuns (8 cols + 2 CHECKs + 2 indexes) + knowledgeSearchCandidates (9 cols + 1 CHECK + 2 indexes)
- `server/lib/ai/vector-adapter.ts` — PgvectorProvider stub replaced with real implementation delegating to searchPgvector()
- `server/routes/admin.ts` — 6 new endpoints under /api/admin/knowledge/vector-search/

### DB changes (10 items)
- `knowledge_embeddings`: is_active (bool), similarity_metric (text), ke_similarity_metric_check, ke_tenant_is_active_idx
- New table `knowledge_search_runs`: 8 cols, ksr_top_k_requested_check, ksr_top_k_returned_check, ksr_tenant_kb_idx, ksr_tenant_created_idx
- New table `knowledge_search_candidates`: 9 cols, ksc_rank_check, ksc_run_idx, ksc_tenant_chunk_idx

### Admin routes (6 endpoints)
POST /run, POST /explain, GET /filter-preview, GET /run/:runId, GET /candidates/:runId, GET /chunk-explain/:chunkId

### Invariants enforced
- INV-VEC1: tenantId + knowledgeBaseId required and validated
- INV-VEC2: Only current_version_id chunks returned
- INV-VEC3: chunk_active=true required
- INV-VEC4: index_state=indexed required
- INV-VEC5: embedding_status=completed + is_active=true required
- INV-VEC6: KB lifecycle_state=active required
- INV-VEC7: document_status=ready required
- INV-VEC8: Empty result returned cleanly, no scope widening
- INV-VEC9: Cross-tenant linkage rejected
- INV-VEC11: Empty/NaN query embedding fails explicitly
- INV-VEC12: Search never mutates lifecycle/billing state

### Validation: 62/62 assertions passed (15 scenarios)
S1 ke new cols, S2 new tables, S3 constraints+indexes, S4 fixture setup, S5 basic search returns 5 ranked candidates, S6 non-current version excluded, S7 archived KB rejected (INV-VEC6), S8 non-ready doc=0 results (INV-VEC7), S9 inactive chunk excluded (INV-VEC3), S10 stale index_state=0 results (INV-VEC4), S11 is_active=false=0 results (INV-VEC5), S12 empty KB=0 results (INV-VEC8), S13 cross-tenant rejected (INV-VEC1/9), S14 empty+NaN embedding rejected (INV-VEC11), S15 explain/filter-preview/chunk-explain/debug-run helpers

## Phase 5E — Retrieval Orchestration Layer (branch: feature/retrieval-orchestration)

### Purpose
Converts Phase 5D vector search results into structured retrieval context for LLM consumption. Deterministic token-budget enforcement, Jaccard+hash duplicate suppression, document proximity grouping, chunk-index ordering, full traceable metadata per entry. Never calls LLMs; never mutates DB lifecycle state.

### New files
- `server/lib/ai/token-budget.ts` — estimateTokens(), estimateChunkTokens(), enforceTokenBudget() (greedy, INV-RET5), wouldExceedBudget(), formatBudgetSummary(). Default budget: 4000 tokens.
- `server/lib/ai/chunk-ranking.ts` — rankChunks() (similarity threshold filter → Jaccard duplicate suppression → per-doc limits → doc proximity grouping → chunk_index ordering → rank assignment). Document group map tracking.
- `server/lib/ai/context-window-builder.ts` — buildContextWindow() (token budget → content hash dedup → entry assembly with full metadata → plain/cited format → summarize). summarizeContextWindow().
- `server/lib/ai/retrieval-orchestrator.ts` — runRetrievalOrchestration() (6-step pipeline), explainRetrievalContext() (selection+exclusion trace), buildContextPreview() (pre-searched candidates), getRetrievalRun() (DB lookup). RetrievalInvariantError class.
- `server/lib/ai/migrate-phase5e.ts` — Raw SQL migration (ran successfully)
- `server/lib/ai/validate-phase5e.ts` — 20 scenarios, 92/92 assertions passed

### Modified files
- `shared/schema.ts` — New table knowledgeRetrievalRuns (14 cols, max_context_tokens CHECK, 2 indexes); insertKnowledgeRetrievalRunSchema + types
- `server/routes/admin.ts` — 4 new endpoints under /api/admin/knowledge/retrieval/ + imports

### DB changes
- New table `knowledge_retrieval_runs`: 14 cols, krr_max_context_check constraint, krr_tenant_kb_idx, krr_tenant_created_idx

### Admin routes (4 endpoints)
- POST /api/admin/knowledge/retrieval/run — full orchestration run
- POST /api/admin/knowledge/retrieval/explain — selection + exclusion trace
- POST /api/admin/knowledge/retrieval/context-preview — from pre-searched candidates
- GET /api/admin/knowledge/retrieval/run/:runId — lookup persisted run

### Invariants enforced
- INV-RET1: tenantId + knowledgeBaseId required
- INV-RET2: All Phase 5D safety filters enforced (current_version, lifecycle, index_state)
- INV-RET3: Non-current document versions excluded via Phase 5D
- INV-RET4: Inactive chunks excluded via Phase 5D
- INV-RET5: Token budget never exceeded (greedy enforceTokenBudget)
- INV-RET6: Retrieval never mutates DB lifecycle/billing state
- INV-RET7: Cross-tenant retrieval impossible (tenantId required)
- INV-RET8: Deterministic output for same input
- INV-RET9: Jaccard similarity + content hash duplicate suppression
- INV-RET10: Full traceable metadata per chunk (chunk_id, doc_id, doc_version_id, kb_id, chunk_index, page, heading, score, metric, hash, tokens)

### Validation: 92/92 assertions passed (20 scenarios)
S01 token estimation, S02 greedy budget enforcement, S03 budget never exceeded (INV-RET5), S04 Jaccard duplicate suppression (INV-RET9), S05 content hash dedup, S06 context ordering (chunk_index), S07 document grouping, S08 per-doc limit, S09 similarity threshold, S10 plain format assembly, S11 cited format assembly, S12 full metadata per chunk (INV-RET10), S13 cross-tenant rejection (INV-RET7), S14 budget summary format, S15 context preview, S16 DB table present, S17 all columns present, S18 CHECK constraint enforced, S19 DB insert+lookup, S20 deterministic output (INV-RET8)

## Phase 5F — Retrieval Quality, Cache & Trust Signals (branch: feature/retrieval-orchestration)

### Purpose
Builds the enterprise observability + cache + trust layer on top of the Phase 5E retrieval orchestration pipeline. Introduces retrieval quality telemetry, a tenant+KB-scoped retrieval cache, embedding version-awareness, and a probabilistic document trust-signal foundation.

### New files (6)
- `server/lib/ai/retrieval-metrics.ts` — recordRetrievalMetrics(), getRetrievalMetricsByRunId(), getRetrievalMetricsSummary()
- `server/lib/ai/retrieval-cache.ts` — hashRetrievalQuery(), getCachedRetrieval(), storeCachedRetrieval(), invalidateRetrievalCacheForKnowledgeBase(), invalidateRetrievalCacheForDocument(), previewExpiredRetrievalCache()
- `server/lib/ai/embedding-lifecycle.ts` — getCurrentEmbeddingVersion(), getCurrentRetrievalVersion(), markKnowledgeBaseForReindex(), previewStaleEmbeddingDocuments(), explainEmbeddingVersionState(). Constants: CURRENT_EMBEDDING_VERSION=v1.0, CURRENT_RETRIEVAL_VERSION=v1.0
- `server/lib/ai/document-trust.ts` — recordDocumentTrustSignal(), calculateDocumentRiskScore(), getDocumentTrustSignals(), getDocumentRiskScore(), explainDocumentTrust()
- `server/lib/ai/migrate-phase5f.ts` — Raw SQL migration (ran successfully)
- `server/lib/ai/validate-phase5f.ts` — 25 scenarios, 84/84 assertions passed

### Modified files (3)
- `shared/schema.ts` — 4 new tables + 3 new columns on existing tables
- `server/routes/admin.ts` — 14 new endpoints (metrics, cache, embedding version, trust signals) + imports
- `replit.md` — Phase 5F documented

### DB changes
- `knowledge_embeddings`: +embedding_version (text nullable)
- `knowledge_retrieval_runs`: +embedding_version (text nullable), +retrieval_version (text nullable)
- New table `retrieval_metrics` (13 cols, 5 CHECKs, 2 indexes, FK → knowledge_retrieval_runs)
- New table `retrieval_cache_entries` (12 cols, status CHECK, 3 indexes)
- New table `document_trust_signals` (9 cols, 2 indexes)
- New table `document_risk_scores` (9 cols, risk_level CHECK, 2 indexes)

### Admin routes (14 endpoints)
- POST /api/admin/knowledge/retrieval-metrics/record
- GET /api/admin/knowledge/retrieval-metrics/:runId
- GET /api/admin/knowledge/retrieval-metrics/summary
- GET /api/admin/knowledge/retrieval-cache/lookup
- POST /api/admin/knowledge/retrieval-cache/store
- POST /api/admin/knowledge/retrieval-cache/invalidate-kb
- POST /api/admin/knowledge/retrieval-cache/invalidate-doc
- GET /api/admin/knowledge/retrieval-cache/expired-preview
- GET /api/admin/knowledge/embedding-version/info
- GET /api/admin/knowledge/embedding-version/explain
- GET /api/admin/knowledge/embedding-version/stale-preview
- POST /api/admin/knowledge/embedding-version/mark-reindex
- POST /api/admin/document-trust/signal
- POST /api/admin/document-trust/risk-score
- GET /api/admin/document-trust/signals/:documentId
- GET /api/admin/document-trust/risk-score/:documentId
- GET /api/admin/document-trust/explain/:documentId

### Invariants
- Cache tenant isolation: getCachedRetrieval requires tenantId + knowledgeBaseId scoping
- INV-TRUST1: confidence_score clamped to 0.0–1.0
- INV-TRUST2: risk_level is always one of low_risk/medium_risk/high_risk/unknown
- INV-TRUST3: explainDocumentTrust includes explicit advisory disclaimer
- hashRetrievalQuery: SHA-256 with whitespace+case normalisation for stable cache keys
- No forced re-embedding in Phase 5F — lifecycle awareness only

### Validation: 84/84 assertions passed (25 scenarios)
S01 metrics record+retrieve, S02 metrics summary, S03 cache store+hit, S04 tenant isolation, S05 expired cache ignored, S06 KB invalidation, S07 hash stability, S08-S09 version constants, S10 explainEmbeddingVersionState, S11 stale preview, S12 trust signal insert, S13-S16 risk score derivation (high/medium/low/unknown), S17 getDocumentTrustSignals, S18 getDocumentRiskScore, S19 explainDocumentTrust, S20 DB tables, S21 DB columns, S22 DB CHECK constraints, S23 FK constraint, S24 sample rows round-trip, S25 admin endpoint shapes

## Phase 5G — Knowledge Asset Registry & Multimodal Foundation (branch: feature/retrieval-orchestration)

### Purpose
Transforms the document-centric foundation into a generalized enterprise asset registry supporting documents, images, videos, audio, emails, and webpages. Foundational only — no OCR, transcription, or multimodal retrieval executed yet. Backward-compatible with Phase 5A–5F document flows.

### New files (6)
- `server/lib/ai/knowledge-assets.ts` — createKnowledgeAsset, createKnowledgeAssetVersion, setKnowledgeAssetCurrentVersion, getKnowledgeAssetById, listKnowledgeAssetsByKnowledgeBase, listKnowledgeAssetsByTenant, updateKnowledgeAssetLifecycle, markKnowledgeAssetProcessingState, explainKnowledgeAsset
- `server/lib/ai/knowledge-storage.ts` — registerStorageObject, getStorageObjectById, listStorageObjectsByTenant, markStorageObjectArchived, markStorageObjectDeleted, explainStorageObject (table: asset_storage_objects)
- `server/lib/ai/knowledge-asset-processing.ts` — enqueueAssetProcessingJob, startAssetProcessingJob, completeAssetProcessingJob, failAssetProcessingJob, listAssetProcessingJobs, explainAssetProcessingState
- `server/lib/ai/knowledge-asset-compat.ts` — explainDocumentToAssetMigrationStrategy, previewLegacyDocumentCompatibility, explainCurrentRegistryState
- `server/lib/ai/migrate-phase5g.ts` — Raw SQL migration (ran successfully, all 4 tables)
- `server/lib/ai/validate-phase5g.ts` — 20 scenarios, 117/117 assertions passed

### Modified files (3)
- `shared/schema.ts` — 4 new tables: knowledge_assets, knowledge_asset_versions, asset_storage_objects, knowledge_asset_processing_jobs
- `server/routes/admin.ts` — 23 new admin endpoints + Phase 5G imports
- `replit.md` — Phase 5G documented

### DB changes (4 new tables)
- `knowledge_assets` — 5 CHECK constraints, 4 indexes, deferred FK to knowledge_asset_versions
- `knowledge_asset_versions` — 2 CHECK constraints, UNIQUE(asset_id, version_number), FK → knowledge_assets, 2 indexes
- `asset_storage_objects` — 3 CHECK constraints, UNIQUE(tenant_id, bucket_name, object_key), 3 indexes (note: distinct from Phase 5B knowledge_storage_objects which is document-version-linked)
- `knowledge_asset_processing_jobs` — 3 CHECK constraints, FK → knowledge_assets + knowledge_asset_versions, 4 indexes

### Design decisions
- `asset_storage_objects` renamed from `knowledge_storage_objects` to avoid collision with Phase 5B's document-version-linked storage table
- Deferred FK: `knowledge_assets.current_version_id` → `knowledge_asset_versions.id` (DEFERRABLE INITIALLY DEFERRED to allow same-transaction inserts)
- Job lifecycle is deterministic: queued → started → completed | failed (transitions enforced in service layer)
- Strategy: additive-coexistence — legacy document tables remain untouched; new asset registry runs alongside

### Admin routes (23 endpoints)
Assets: POST create, GET by id, GET by-kb, GET by-tenant, POST lifecycle, POST processing-state, GET explain
Versions: POST create, POST set-current-version
Storage: POST register, GET by id, GET by-tenant, POST archive, POST delete, GET explain
Jobs: POST enqueue, POST start, POST complete, POST fail, GET by-asset, GET explain-state
Compat: GET migration-strategy, GET legacy-preview, GET registry-state

### Validation: 117/117 assertions passed (20 scenarios)
S01 document asset, S02 image asset, S03 video asset, S04 asset version, S05 version switch, S06 invalid asset_type rejected, S07 invalid lifecycle_state rejected, S08 invalid processing_state rejected, S09 job enqueue/start/complete, S10 job failure + invalid transition, S11 storage object register, S12 archive/delete transitions, S13 tenant isolation, S14 KB-scoped listing, S15 version uniqueness, S16 explainKnowledgeAsset, S17 explainAssetProcessingState, S18 compat migration strategy + legacy preview + registry state, S19 explainStorageObject, S20 DB tables/indexes/constraints/CHECK enforcement
