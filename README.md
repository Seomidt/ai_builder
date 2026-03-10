# AI Builder Platform — V1

Internal control plane for AI-driven software generation. Built on Next.js-style patterns using Express + React + Drizzle ORM.

## Architecture

```
client/src/
  components/layout/   AppShell, Sidebar
  pages/               dashboard, projects, architectures, runs, integrations, settings
  lib/                 queryClient, utils

server/
  repositories/        projects, architectures, runs, integrations, knowledge
  services/            projects, architectures, runs, integrations
  routes.ts            API route handlers (thin — delegate to storage/services)
  storage.ts           IStorage interface + DatabaseStorage implementation
  db.ts                Drizzle + pg Pool

shared/
  schema.ts            All Drizzle tables, insert schemas, TypeScript types
```

## Database Schema (V1)

| Domain | Tables |
|--------|--------|
| Identity | `profiles` (extends Supabase Auth) |
| Multi-tenancy | `organizations`, `organization_members` |
| Projects | `projects` (status: active/archived) |
| Architectures | `architecture_profiles`, `architecture_versions`, `architecture_agent_configs`, `architecture_capability_configs`, `architecture_template_bindings`, `architecture_policy_bindings` |
| AI Runs | `ai_runs`, `ai_steps`, `ai_artifacts`, `ai_tool_calls`, `ai_approvals` |
| Integrations | `integrations`, `organization_secrets` |
| Knowledge (RAG prep) | `knowledge_documents` |

## Local Setup

```bash
# 1. Copy env template
cp .env.example .env

# 2. Fill in your values (DATABASE_URL is provisioned by Replit automatically)

# 3. Push schema to database
npm run db:push

# 4. Start development server
npm run dev
```

## Environment Variables

See `.env.example` for all variables. Critical ones:

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | Yes | Auto-provisioned by Replit |
| `SESSION_SECRET` | Yes | Random string, min 32 chars |
| `GITHUB_TOKEN` | For GitHub tools | PAT with repo scope |
| `OPENAI_API_KEY` | For AI agents | Never expose client-side |
| `SUPABASE_URL` | For Supabase Auth | Optional in V1 |
| `SUPABASE_SERVICE_ROLE_KEY` | For Supabase Auth | Never expose client-side |

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
| POST | `/api/architectures/:id/archive` | Archive profile |
| POST | `/api/architectures/:id/versions` | Create version (draft) |
| POST | `/api/architectures/:id/versions/:versionId/publish` | Publish version → sets current_version_id |
| PUT | `/api/architectures/:id/versions/:versionId/agents` | Upsert agent configs |
| PUT | `/api/architectures/:id/versions/:versionId/capabilities` | Upsert capability configs |

### Runs (lifecycle)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/runs` | List runs (filter: ?status=, ?projectId=) |
| POST | `/api/runs` | Create run |
| GET | `/api/runs/:id` | Get run + steps + artifacts + tool calls + approvals |
| PATCH | `/api/runs/:id/status` | Update run status |
| POST | `/api/runs/:id/steps` | Append step |
| POST | `/api/runs/:id/artifacts` | Append artifact |
| POST | `/api/runs/:id/tool-calls` | Append tool call |
| POST | `/api/runs/:id/approvals` | Append approval |
| PATCH | `/api/runs/:id/approvals/:approvalId` | Resolve approval |

### Integrations
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/integrations` | List all 5 providers (with status) |
| POST | `/api/integrations` | Upsert integration |
| GET | `/api/integrations/:provider` | Get by provider |

## Multi-tenancy

All requests use `x-organization-id` header to determine the tenant. Default is `demo-org` for development.

In production with Supabase Auth, extract the organization from the JWT and set the header server-side.

## V2 TODO

- [ ] Connect Supabase Auth (JWT validation middleware)
- [ ] Implement full RLS policies on all tenant tables
- [ ] Add GitHub tool execution (branch, file write, PR creation)
- [ ] Add OpenAI provider behind `LLMProvider` interface
- [ ] Add `knowledge_chunks` and `knowledge_vectors` tables
- [ ] Add `deployment_targets` table
- [ ] Vercel deployment automation

## V3 TODO

- [ ] `expert_teams`, `expert_team_members` tables
- [ ] Graph-based knowledge retrieval
- [ ] Project decision tracking
- [ ] Vercel preview deploy automation
- [ ] Supabase branch automation
