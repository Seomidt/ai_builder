# AI Builder Platform — V1 (Phase 3G.1 complete)

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
      config.ts          AI_MODEL_ROUTES, AiProviderKey, runtime limits
      runner.ts          runAiCall() — single entry point
      router.ts          resolveRoute() — async, override-aware
      overrides.ts       loadOverride() — DB override loader + TTL cache
      types.ts           AiCallContext, AiCallResult
      errors.ts          Typed error hierarchy
      usage.ts           logAiUsage() → ai_usage + aggregate upsert to tenant_ai_usage_periods
      usage-periods.ts   getCurrentPeriod() — centralised period boundary helper
      pricing.ts         loadPricing() — DB first, code default fallback + TTL cache
      costs.ts           estimateAiCost() — token × rate calculation
      guards.ts          AI usage guardrails — aggregate-first getCurrentAiUsageForPeriod, BUDGET_MODE_POLICY
      usage-summary.ts   getAiUsageSummary() — normalized tenant usage contract for future UI
      providers/         AiProvider interface, OpenAI adapter, registry
      prompts/           getSummarizePrompt()
    supabase.ts, github.ts, github-commit-format.ts
  features/
    ai-summarize/        summarize.service.ts
  middleware/            auth.ts (JWT → req.user)
  repositories/          projects, architectures, runs, integrations, knowledge
  services/              projects, architectures, runs, integrations, run-executor
  routes.ts              Thin API handlers
  storage.ts             IStorage + DatabaseStorage
  db.ts                  Drizzle + pg pool

shared/
  schema.ts              All Drizzle tables + insert schemas + TypeScript types
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
| 3F | `feature/ai-pricing-registry` | AI Pricing Registry — ai_model_pricing, loadPricing(), estimateAiCost(), estimated_cost_usd in ai_usage |
| 3G | `feature/ai-usage-guardrails` | AI Usage Guardrails — ai_usage_limits, usage_threshold_events, guards.ts, BUDGET_MODE_POLICY, hard stop, usage-summary.ts |
| 3G.1 | `feature/ai-usage-hardening` | Usage Data Hardening — provider field on ai_usage, composite indexes, tenant_ai_usage_periods aggregate table, getCurrentPeriod(), aggregate-first guardrails, synchronous aggregate upsert |

## AI Stack — Routing Flow

```
runAiCall(context, input)
  → resolveRoute(routeKey, tenantId)
      → loadOverride() — tenant → global → null
      → fallback: AI_MODEL_ROUTES[routeKey]
  → getProvider(provider)
  → [if tenantId] loadUsageLimit() + getCurrentAiUsageForPeriod()
  → evaluateAiUsageState() → normal | budget_mode | blocked
  → if blocked: throw AiBudgetExceededError (no provider call)
  → if budget_mode: apply BUDGET_MODE_POLICY (maxOutputTokens + concise prefix)
  → provider.generateText(...)
  → loadPricing(provider, model) — DB active row → code default
  → estimateAiCost(usage, pricing)
  → logAiUsage(..., estimatedCostUsd)          ← writes ai_usage + upserts tenant_ai_usage_periods
  → [if non-normal] maybeRecordThresholdEvent()
```

## Key Files

- `shared/schema.ts` — all tables including ai_usage, ai_model_overrides, ai_model_pricing, ai_usage_limits, usage_threshold_events, tenant_ai_usage_periods
- `server/lib/ai/config.ts` — AI_MODEL_ROUTES (6 routes), AiProviderKey
- `server/lib/ai/runner.ts` — runAiCall() + guardrails + cost estimation
- `server/lib/ai/router.ts` — resolveRoute() (async)
- `server/lib/ai/overrides.ts` — loadOverride() + TTL cache
- `server/lib/ai/pricing.ts` — loadPricing() + TTL cache
- `server/lib/ai/costs.ts` — estimateAiCost() + code defaults
- `server/lib/ai/guards.ts` — loadUsageLimit, getCurrentAiUsageForPeriod (aggregate-first), evaluateAiUsageState, BUDGET_MODE_POLICY, maybeRecordThresholdEvent
- `server/lib/ai/usage-periods.ts` — getCurrentPeriod() — single source of period boundaries
- `server/lib/ai/usage-summary.ts` — getAiUsageSummary() — normalized usage contract
- `server/lib/ai/errors.ts` — AiBudgetExceededError + typed error hierarchy
- `server/lib/ai/providers/registry.ts` — ACTIVE_PROVIDERS
- `server/features/ai-summarize/summarize.service.ts` — first feature

## Database Notes

- **Demo org**: `demo-org`, projectId `ebd30281-0f9c-43c8-bb06-c20e531e8fc4`
- **DB push command**: `npm run db:push`
- **Next migration index**: `0003_*`
- `ai_model_overrides` has coalesce unique index applied directly via SQL (not in Drizzle schema)
- `ai_model_pricing` has partial unique index `ON ai_model_pricing (provider, model) WHERE is_active = true` applied via SQL
- `ai_usage.estimated_cost_usd` is `numeric(12,8)` — Drizzle returns as string, convert with `Number()` when reading
- `ai_usage_limits` has unique index on `tenant_id` — one row per tenant
- `usage_threshold_events` — append-only foundation, deduplicated by 24h window per event_type
- Budget mode: `BUDGET_MODE_POLICY` in guards.ts — `maxOutputTokens: 512`, concise system prompt prefix
- `ai_usage.provider` — added in Phase 3G.1, nullable, written by runner.ts via logAiUsage()
- `ai_usage` composite indexes: `(tenant_id, created_at)` and `(tenant_id, status, created_at)` — added Phase 3G.1
- `tenant_ai_usage_periods` — aggregate summary table (Phase 3G.1). One row per tenant+period. Unique index on (tenant_id, period_start, period_end). Updated synchronously in logAiUsage() via ON CONFLICT DO UPDATE. Guards read from this table first, fall back to raw ai_usage if no aggregate row yet.
- Period boundaries: `getCurrentPeriod()` in `server/lib/ai/usage-periods.ts` — calendar month, `created_at >= periodStart AND created_at < periodEnd`

## V2 / Next TODO

- [ ] Phase 4: Admin UI for model routing overrides
- [ ] Real Supabase Auth session (frontend login/signup)
- [ ] GitHub tool execution (create branch, write files, open PR)
- [ ] `knowledge_chunks` + `knowledge_vectors` tables
- [ ] Full RLS policies on all tenant tables
- [ ] Vercel deployment automation

## Running

```bash
npm run dev       # Start dev server (port 5000)
npm run db:push   # Sync schema to DB
```
