# AI Builder Platform — V1

Internal control plane for AI-driven software generation. Built on Express + React + Drizzle ORM + Supabase.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Wouter, TanStack Query, Shadcn UI, Tailwind CSS |
| Backend | Express.js, TypeScript, Zod validation |
| Database | Supabase Postgres (PostgreSQL 17.6) via Drizzle ORM + connection pooler |
| Auth | Supabase Auth (JWT middleware wired, demo fallback for dev) |
| AI | OpenAI (Responses API) — provider-abstracted, fully replaceable |
| GitHub | PAT-based integration, commit/branch/PR format utilities |

---

## Project Structure

```
client/src/
  components/layout/     AppShell, Sidebar
  pages/                 dashboard, projects, architectures, runs, integrations, settings
  lib/                   queryClient, utils

server/
  lib/
    ai/
      config.ts                  AI_MODEL_ROUTES, AiProviderKey, runtime limits, cache policies
      runner.ts                  runAiCall() — single entry point for all AI features
      router.ts                  resolveRoute() — async, tenant/global override-aware
      overrides.ts               loadOverride() — DB override loader with TTL cache
      types.ts                   AiCallContext, AiCallResult
      errors.ts                  Typed error hierarchy — all AiError subclasses
      usage.ts                   logAiUsage() → ai_usage + tenant_ai_usage_periods upsert
      usage-periods.ts           getCurrentPeriod() — calendar month boundary helper
      pricing.ts                 loadPricing() — DB first, code default fallback + TTL cache
      costs.ts                   estimateAiCost() — token × rate calculation
      guards.ts                  AI usage guardrails — budget mode, blocked state, thresholds
      usage-summary.ts           getAiUsageSummary() — normalized tenant usage contract
      request-safety.ts          Token cap, rate limit, concurrency guard
      request-safety-summary.ts  getRequestSafetySummary() — backend summary
      response-cache.ts          Tenant-isolated AI response cache (SHA-256 fingerprint)
      cache-summary.ts           getCacheSummary() — hit/miss/write counts
      cache-retention.ts         Batch cleanup SQL for expired ai_response_cache rows
      idempotency.ts             2-layer duplicate suppression (in-process + DB)
      request-state-summary.ts   getAiRequestStateSummary() — idempotency state counts
      request-state-retention.ts Cleanup SQL for ai_request_states + ai_request_state_events
      retention.ts               Cleanup SQL for ai_usage rows (90-day window)
      providers/
        provider.ts              AiProvider interface
        openai-provider.ts       OpenAI Responses API adapter
        registry.ts              ACTIVE_PROVIDERS map, getProvider()
      prompts/
        summarize.ts             getSummarizePrompt()
    supabase.ts
    github.ts
    github-commit-format.ts
  features/
    ai-summarize/
      summarize.service.ts       summarize() — first real AI feature
  middleware/
    auth.ts                      JWT → req.user
  repositories/                  projects, architectures, runs, integrations, knowledge
  services/                      projects, architectures, runs, integrations, run-executor
  routes.ts                      Thin API handlers
  storage.ts                     IStorage + DatabaseStorage
  db.ts                          Drizzle + pg pool

shared/
  schema.ts                      All Drizzle tables + insert schemas + TypeScript types
```

---

## Database Schema (25 tables)

| Domain | Tables |
|--------|--------|
| Identity | `profiles` |
| Multi-tenancy | `organizations`, `organization_members` |
| Projects | `projects` |
| Architectures | `architecture_profiles`, `architecture_versions`, `architecture_agent_configs`, `architecture_capability_configs`, `architecture_template_bindings`, `architecture_policy_bindings` |
| AI Runs | `ai_runs`, `ai_steps`, `ai_artifacts`, `ai_tool_calls`, `ai_approvals`, `artifact_dependencies` |
| Integrations | `integrations`, `organization_secrets` |
| Knowledge | `knowledge_documents` |
| AI Infrastructure | `ai_usage`, `ai_model_overrides`, `ai_model_pricing`, `ai_usage_limits`, `usage_threshold_events`, `tenant_ai_usage_periods`, `tenant_rate_limits`, `request_safety_events`, `ai_response_cache`, `ai_cache_events`, `ai_request_states`, `ai_request_state_events` |

### AI Infrastructure Tables

| Table | Purpose |
|-------|---------|
| `ai_usage` | Every AI call — tokens, cost, status, requestId, latency |
| `ai_model_overrides` | Route-level model/provider overrides (tenant or global) |
| `ai_model_pricing` | Token pricing per provider+model — DB first, code fallback |
| `ai_usage_limits` | Per-tenant budget limits and hard stop thresholds |
| `usage_threshold_events` | Budget warning/blocked events (deduplicated 24h window) |
| `tenant_ai_usage_periods` | Aggregate cost summary per tenant+period (guardrail source of truth) |
| `tenant_rate_limits` | Per-tenant RPM/RPH overrides |
| `request_safety_events` | Token cap, rate limit, concurrency block events |
| `ai_response_cache` | Cached successful AI responses (TTL 1h, tenant-scoped) |
| `ai_cache_events` | Cache hit/miss/write/skip event log |
| `ai_request_states` | Idempotency state per (tenant, request_id) — 24h TTL |
| `ai_request_state_events` | Idempotency lifecycle events — 30-day retention |

---

## AI Stack (Phase 3)

All AI calls flow through a single orchestration pipeline in `runner.ts`:

```
feature code
  → runAiCall(context, input)
      1. Resolve route (provider + model)
      2. Get provider adapter
      3. Idempotency check [if request_id present]
         ├─ duplicate_inflight  → 409 Conflict (no provider call)
         ├─ duplicate_replay    → return stored result (no cost row)
         └─ owned               → proceed
      4. Resolve effective safety config (tenant override → global defaults)
      5. Token cap precheck (413 if exceeded)
      6. Rate limit check (429 if exceeded)
      7. Concurrency guard acquire (429 if exceeded)
      8. Budget/usage guard
         ├─ blocked    → 402 Budget Exceeded (no provider call)
         └─ budget_mode → apply BUDGET_MODE_POLICY (reduced tokens + prefix)
      9. Cache lookup [if route cacheable + tenantId present]
         ├─ HIT  → return cached result (no provider call, no cost row)
         └─ MISS → continue
     10. Provider call (OpenAI Responses API)
     11. Usage logging → ai_usage + tenant_ai_usage_periods
     12. Cache write (success only)
     13. Mark request completed (idempotency state)
     14. Release concurrency slot + idempotency ownership (always, in finally)
```

### Model Routes (code defaults)

| Key | Provider | Model | Use case |
|-----|----------|-------|----------|
| `default` | openai | gpt-4.1-mini | Fast, cost-efficient |
| `heavy` | openai | gpt-4.1 | Complex reasoning |
| `nano` | openai | gpt-4.1-nano | Trivial tasks |
| `coding` | openai | gpt-4.1 | Code generation |
| `cheap` | google | gemini-2.0-flash | Placeholder |
| `reasoning` | anthropic | claude-opus-4-5 | Placeholder |

### Model Routing Overrides

```sql
-- Example: override 'default' route globally to use gpt-4.1
INSERT INTO ai_model_overrides (scope, scope_id, route_key, provider, model, is_active)
VALUES ('global', NULL, 'default', 'openai', 'gpt-4.1', true);
```

### Idempotency

Duplicate requests are suppressed at two layers:
1. **In-process Set** — same-process concurrent duplicates blocked immediately
2. **DB `ai_request_states`** — cross-request/process duplicates and replay

| Scenario | Behavior | HTTP |
|----------|----------|------|
| No `request_id` | Normal execution | 200 |
| First request | Execute + store result | 200 |
| Duplicate while in-flight | Blocked | 409 + Retry-After: 5 |
| Duplicate after success | Replay stored result (no cost row) | 200 |
| Duplicate after failure | New execution allowed (retryable) | 200 |

### Response Cache

Enabled for `"default"` route only. TTL: 3600s. Fingerprint:
`SHA-256(v1:{tenantId}:{routeKey}:{provider}:{model}:{maxOutputTokens}:{contentHash})`

Cache hits produce **no ai_usage provider-cost rows** — observable via `ai_cache_events` only.

### HTTP Error Semantics

| Error | HTTP | Code | Retry-After |
|-------|------|------|-------------|
| Token cap exceeded | 413 | `token_cap_exceeded` | — |
| Rate limit exceeded | 429 | `rate_limit_exceeded` | 60s / 3600s |
| Concurrency exceeded | 429 | `concurrency_limit_exceeded` | 5s |
| Budget exceeded | 402 | `ai_budget_exceeded` | — |
| Duplicate inflight | 409 | `duplicate_inflight` | 5s |
| Provider quota | 429 | `ai_quota_exceeded` | 60s |
| Provider error | 502 | `ai_service_error` | — |
| Timeout | 504 | `ai_timeout` | — |
| Unavailable | 503 | `ai_unavailable` | — |

---

## API Routes

### Projects
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List active projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get project |
| PATCH | `/api/projects/:id` | Update project |
| POST | `/api/projects/:id/archive` | Archive (soft delete) |

### Architectures
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/architectures` | List profiles |
| POST | `/api/architectures` | Create profile |
| GET | `/api/architectures/:id` | Get profile + versions |
| PATCH | `/api/architectures/:id` | Update profile |
| POST | `/api/architectures/:id/archive` | Archive |
| POST | `/api/architectures/:id/versions` | Create version (draft) |
| POST | `/api/architectures/:id/versions/:versionId/publish` | Publish version |
| PUT | `/api/architectures/:id/versions/:versionId/agents` | Upsert agent configs |
| PUT | `/api/architectures/:id/versions/:versionId/capabilities` | Upsert capability configs |

### Runs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/runs` | List runs |
| POST | `/api/runs` | Create run |
| GET | `/api/runs/:id` | Get run + steps + artifacts |
| PATCH | `/api/runs/:id/status` | Update status |
| POST | `/api/runs/:id/execute` | Start AI pipeline (async, 202) |
| POST | `/api/runs/:id/steps` | Append step |
| POST | `/api/runs/:id/artifacts` | Append artifact |
| POST | `/api/runs/:id/tool-calls` | Append tool call |
| POST | `/api/runs/:id/approvals` | Append approval |
| PATCH | `/api/runs/:id/approvals/:approvalId` | Resolve approval |
| GET | `/api/runs/:id/commit-preview` | GitHub commit preview |

### Integrations
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/integrations` | List all 5 providers |
| POST | `/api/integrations` | Upsert integration |
| GET | `/api/integrations/:provider` | Get by provider |

### AI
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ai/summarize` | Summarize text (min 20 chars) |

---

## Phase History

| Phase | Branch | Description | Status |
|-------|--------|-------------|--------|
| 1 | `main` | Core platform: schema, repositories, services, UI | Complete |
| 2 | `main` | AI run pipeline: 4-agent chain, run executor, GitHub commit format | Complete |
| 3A | `main` | AI foundation: config, service, ai_usage table, logAiUsage() | Complete |
| 3B | `main` | AI orchestration: runAiCall(), AiCallContext, typed errors, requestId tracing | Complete |
| 3C | `feature/ai-router` | Provider abstraction: AiProvider interface, OpenAI adapter, registry, router | Complete |
| 3D | `feature/ai-summarize` | First AI feature: summarize prompt, service, POST /api/ai/summarize | Complete |
| 3E | `feature/ai-route-overrides` | Model routing overrides: ai_model_overrides table, loadOverride(), async router | Complete |
| 3F | `feature/ai-pricing-registry` | AI Pricing Registry: ai_model_pricing, loadPricing(), estimateAiCost(), estimated_cost_usd | Complete |
| 3G | `feature/ai-usage-guardrails` | AI Usage Guardrails: ai_usage_limits, usage_threshold_events, guards.ts, budget mode, hard stop | Complete |
| 3G.1 | `feature/ai-usage-hardening` | Usage Hardening: tenant_ai_usage_periods aggregate, getCurrentPeriod(), aggregate-first guardrails | Complete |
| 3H | `feature/ai-usage-final-hardening` | Request Safety: token cap (413), rate limit (429), concurrency guard (429), request_safety_events | Complete |
| 3H.1 | `feature/http-error-semantics` | HTTP Error Semantics: httpStatus + errorCode + Retry-After on all AiError subclasses | Complete |
| 3I | `feature/ai-response-cache` | AI Response Cache: SHA-256 fingerprint, TTL, tenant isolation, cache hit/miss/write events | Complete |
| 3I.1 | `feature/ai-response-cache` | Cache Key Hardening: maxOutputTokens in fingerprint to prevent cross-config collisions | Complete |
| 3I.2 | `feature/cache-cleanup-foundation` | Cache Cleanup Foundation: preview + batch cleanup SQL for ai_response_cache | Complete |
| 3I.3 | `feature/cache-batch-cleanup` | Batch Cache Cleanup: oldest-first deletion, configurable CACHE_CLEANUP_BATCH_SIZE | Complete |
| 3J | `feature/ai-idempotency-layer` | AI Idempotency: 2-layer duplicate suppression, in-flight 409, completed replay, failed retry | Complete |
| 3J.1 | `feature/request-state-retention` | Request State Retention: expires_at states cleanup, 30-day events cleanup SQL | Complete |

---

## Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables (see below)

# 3. Push schema to database
npm run db:push

# 4. Start dev server
npm run dev
```

## Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `SUPABASE_DB_POOL_URL` | Yes | Supabase pooler connection string |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side only |
| `SESSION_SECRET` | Yes | Random string, 32+ chars |
| `OPENAI_API_KEY` | Yes | Server-side only, never client |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Yes | PAT with repo scope |

---

## Multi-tenancy

All requests use `x-organization-id` header to identify the tenant. Defaults to `demo-org` in development. In production, the organization is resolved from the Supabase JWT.

---

## Design Rules

- **No hard delete** — `projects`, `architecture_profiles`, `ai_runs` use `status` field
- **Architecture versioning is first-class** — `current_version_id` + `is_published` on versions
- **AI Runs as lifecycle** — dedicated append operations for steps, artifacts, tool calls, approvals
- **All AI calls go through `runAiCall()`** — never call generateText() or logAiUsage() directly
- **Overrides are route_key-based** — features map to route keys, route keys map to overrides
- **Server-side secrets only** — GitHub/OpenAI/Supabase service role never reach the client
- **Idempotency requires request_id** — duplicate suppression only activates when `X-Request-Id` is present
- **Cache hits produce no cost rows** — observable via ai_cache_events only
- **Failed request_ids are retryable** — transient errors do not permanently block a request_id
- **Retention is manual** — no scheduler; cleanup SQL is provided in retention foundation files

---

## Next

- [ ] Phase 4: Admin UI for model routing overrides + usage dashboard
- [ ] Real Supabase Auth session (frontend login/signup)
- [ ] GitHub tool execution (create branch, write files, open PR)
- [ ] `knowledge_chunks` + `knowledge_vectors` tables
- [ ] Full RLS policies on all tenant tables
- [ ] Vercel deployment automation
- [ ] Retention cron jobs for ai_response_cache, ai_request_states, ai_request_state_events, ai_usage
