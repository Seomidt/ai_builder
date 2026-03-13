# AI Builder Platform — V1 (Phase 4Q complete)

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
- **Retention is manual**: no scheduler; cleanup SQL provided in retention foundation files
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

shared/
  schema.ts                      All Drizzle tables + insert schemas + TypeScript types (33 tables)
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

## V2 / Next TODO

- [x] Phase 4B: Wallet/Credit Ledger — tenant credit accounts + immutable ledger + billing-driven debit
- [ ] Phase 4C: Stripe metered billing sync
- [ ] Phase 4: Admin UI for model routing overrides + usage dashboard
- [ ] Real Supabase Auth session (frontend login/signup)
- [ ] GitHub tool execution (create branch, write files, open PR)
- [ ] `knowledge_chunks` + `knowledge_vectors` tables
- [ ] Full RLS policies on all tenant tables
- [ ] Vercel deployment automation
- [ ] Retention cron jobs for all ai_* tables

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
