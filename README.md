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
      config.ts          AI_MODEL_ROUTES, AiProviderKey, runtime limits
      runner.ts          runAiCall() — single entry point for all AI features
      router.ts          resolveRoute() — async, tenant/global override-aware
      overrides.ts       loadOverride() — DB override loader with TTL cache
      types.ts           AiCallContext, AiCallResult
      errors.ts          Typed error hierarchy (AiServiceError, AiQuotaError, ...)
      usage.ts           logAiUsage() → ai_usage table
      providers/
        provider.ts      AiProvider interface
        openai-provider.ts  OpenAI Responses API adapter
        registry.ts      ACTIVE_PROVIDERS map, getProvider()
      prompts/
        summarize.ts     getSummarizePrompt()
    supabase.ts
    github.ts
    github-commit-format.ts
  features/
    ai-summarize/
      summarize.service.ts   summarize() — first real AI feature
  middleware/
    auth.ts              JWT → req.user
  repositories/          projects, architectures, runs, integrations, knowledge
  services/              projects, architectures, runs, integrations, run-executor
  routes.ts              Thin API handlers
  storage.ts             IStorage + DatabaseStorage
  db.ts                  Drizzle + pg pool

shared/
  schema.ts              All Drizzle tables + insert schemas + TypeScript types
```

---

## Database Schema (21 tables)

| Domain | Tables |
|--------|--------|
| Identity | `profiles` |
| Multi-tenancy | `organizations`, `organization_members` |
| Projects | `projects` |
| Architectures | `architecture_profiles`, `architecture_versions`, `architecture_agent_configs`, `architecture_capability_configs`, `architecture_template_bindings`, `architecture_policy_bindings` |
| AI Runs | `ai_runs`, `ai_steps`, `ai_artifacts`, `ai_tool_calls`, `ai_approvals`, `artifact_dependencies` |
| Integrations | `integrations`, `organization_secrets` |
| Knowledge | `knowledge_documents` |
| AI Infrastructure | `ai_usage`, `ai_model_overrides` |

### ai_usage
Logs every AI call made through `runAiCall()`. Fields: feature, tenantId, userId, requestId, model, prompt/completion/total tokens, inputPreview, status, errorMessage, latencyMs.

### ai_model_overrides
Stores DB-level routing overrides for AI model selection. Overrides are keyed by `route_key` (not feature). Scopes: `global` and `tenant`. Priority: tenant → global → code default.

---

## AI Stack (Phase 3)

All AI calls flow through a single pipeline:

```
feature code
  → runAiCall(context, input)          runner.ts
      → resolveRoute(routeKey, tenantId)  router.ts
          → loadOverride(routeKey, tenantId)  overrides.ts
              → DB: tenant override?
              → DB: global override?
              → fallback: AI_MODEL_ROUTES[routeKey]
      → getProvider(provider)           registry.ts
      → provider.generateText(...)      openai-provider.ts
      → logAiUsage(...)                 usage.ts
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

DB overrides can change which model is used for a route key, per tenant or globally, without code changes or redeploys.

```sql
-- Example: override 'default' route globally to use gpt-4.1
INSERT INTO ai_model_overrides (scope, scope_id, route_key, provider, model, is_active)
VALUES ('global', NULL, 'default', 'openai', 'gpt-4.1', true);
```

Cache TTLs: 60s (hit), 10s (not found), 5min stale grace on DB failure.

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

---

## Next

- [ ] Phase 4: Admin UI for model routing overrides
- [ ] Real Supabase Auth session (frontend login/signup)
- [ ] GitHub tool execution (create branch, write files, open PR)
- [ ] `knowledge_chunks` + `knowledge_vectors` tables
- [ ] Full RLS policies on all tenant tables
- [ ] Vercel deployment automation
