# AI Builder Platform — V1 (Phase 2)

Internal control plane for AI-driven software generation. Express + React + Drizzle ORM.

## Stack

- **Frontend**: React 19, Wouter (routing), TanStack Query, Shadcn UI, Tailwind CSS (dark navy/teal theme)
- **Backend**: Express.js, TypeScript, Zod validation
- **Auth**: Supabase Auth (JWT middleware wired, demo fallback for dev)
- **Database**: Supabase Postgres (PostgreSQL 17.6) via Drizzle ORM + connection pooler
- **GitHub**: GITHUB_TOKEN available server-side for V1.1+ tools
- **Architecture**: Repository → Service → Route handler (strict layer separation)

## Key Design Rules

- **No hard delete**: `projects`, `architecture_profiles`, `ai_runs` use `status` field
- **Architecture versioning is first-class**: `current_version_id` + `is_published` on versions
- **AI Runs as lifecycle**: dedicated append ops for steps, artifacts, tool calls, approvals
- **Richer step/artifact metadata**: `title`, `description`, `tags`, `path`, `version` fields
- **Multi-tenancy**: `organization_id` only on top-level entities; children inherit via FK
- **Server-side secrets only**: GitHub/OpenAI/Supabase service role never reach the client
- **Auth middleware**: `req.user` populated from Supabase JWT or demo fallback

## Environment Variables Required

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | Yes | Auto-provisioned by Replit |
| `SESSION_SECRET` | Yes | Random string 32+ chars |
| `SUPABASE_URL` | Yes | Project URL |
| `SUPABASE_ANON_KEY` | Yes | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side only — never client |
| `GITHUB_TOKEN` | Yes | PAT with repo scope |
| `GITHUB_OWNER` | No | Default org/user for GitHub ops |
| `GITHUB_REPO` | No | Default repo for GitHub ops |
| `OPENAI_API_KEY` | Phase 2 | Server-side only |

## Project Structure

```
client/src/
  components/layout/   AppShell, Sidebar
  pages/               dashboard, projects, architectures, runs, integrations, settings
  lib/                 queryClient, utils

server/
  lib/                 supabase.ts, github.ts, github-commit-format.ts
  lib/agents/          types.ts, planner-agent.ts, ux-agent.ts, architect-agent.ts, review-agent.ts, registry.ts
  middleware/          auth.ts (JWT → req.user)
  repositories/        projects, architectures, runs (+ artifact deps), integrations, knowledge
  services/            projects, architectures, runs, integrations, run-executor
  routes.ts            Thin API handlers
  storage.ts           IStorage + DatabaseStorage
  db.ts                Drizzle + pg pool

shared/
  schema.ts            All Drizzle tables + insert schemas + TypeScript types
```

## Phase 2 — AI Run Pipeline (COMPLETE)

### Agent Pipeline
4 typed agents chained in execution order:
1. `planner_agent` — Parses goal into structured plan (phases/tasks) → `plan` artifact
2. `ux_agent` — Translates plan into UX spec (screens/components/flows) → `ux_spec` artifact
3. `architect_agent` — Produces tech arch spec + file tree → `arch_spec` + `file_tree` artifacts
4. `review_agent` — Reviews all artifacts, gate report with pass/warn/fail checks → `review` artifact

### Run Executor
- `POST /api/runs/:id/execute` — fires async pipeline, returns 202 immediately
- Reads `architecture_agent_configs` to resolve pipeline; falls back to `DEFAULT_PIPELINE`
- Creates steps (running → completed), persists artifacts, creates artifact_dependencies
- Sets `finished_at` on completion, run status: `completed` | `failed`

### Agent Registry
- `server/lib/agents/registry.ts` — maps agentKey → AgentContract
- Add new agents by implementing `AgentContract` and registering in registry
- V1: deterministic output generators; V2: plug in OpenAI function-calling per agent

### New Routes
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/runs/:id/execute` | Start pipeline (async, 202) |
| GET | `/api/runs/:id/artifact-dependencies` | List artifact deps for a run |
| GET | `/api/runs/:id/commit-preview` | GitHub commit preview (metadata only) |

### UI
- `/runs` — Run list with run_number, title, status, clickable rows
- `/runs/:id` — Run detail: Steps timeline, Artifacts grid, Commit Preview panel
- Auto-refresh every 2s while run is active

## Database Schema (19 tables)

| Domain | Tables |
|--------|--------|
| Identity | `profiles` |
| Multi-tenancy | `organizations`, `organization_members` |
| Projects | `projects` (+ github_owner, github_repo, github_default_branch, github_repo_url) |
| Architectures | `architecture_profiles`, `architecture_versions` (+ version_label, description, changelog), `architecture_agent_configs`, `architecture_capability_configs`, `architecture_template_bindings`, `architecture_policy_bindings` |
| AI Runs | `ai_runs` (+ run_number, title, description, tags, finished_at, github_*), `ai_steps` (+ title, description, tags, startedAt, completedAt), `ai_artifacts` (+ description, path, version, tags), `ai_tool_calls`, `ai_approvals` |
| Artifact Graph | `artifact_dependencies` (from_artifact_id, to_artifact_id, dependency_type) |
| Integrations | `integrations`, `organization_secrets` |
| Knowledge (RAG prep) | `knowledge_documents` |

## GitHub Versioning (metadata layer — write pipeline NOT yet active)

Commit format (Phase 2 ready):
- Title: `[AI RUN {run_number}] {run_title}`
- Body: Architecture / Version / Run ID / Steps / Tags / Changelog
- Branch: `ai-run/{run_number}/{slugified-title}`
- Tags: `ai-run-v{run_number}`, `architecture-{slug}-v{version}`

Key files:
- `server/lib/github-commit-format.ts` — commit/tag/branch formatters (read-only utility)
- `GET /api/runs/:id/commit-preview` — returns preview of what commit will look like

## Migrations

| File | Description |
|------|-------------|
| `migrations/0000_calm_thunderbird.sql` | V1 baseline — all 18 tables |
| `migrations/0001_premium_james_howlett.sql` | GitHub versioning metadata — run_number, title, description, tags, finished_at, github_*, version_label, changelog |

## V2 TODO

- [ ] Real Supabase Auth session (frontend login/signup pages)
- [ ] GitHub tool execution (create branch, write file, open PR)
- [ ] OpenAI provider behind `LLMProvider` interface
- [ ] `knowledge_chunks` + `knowledge_vectors` tables
- [ ] Vercel deployment automation
- [ ] Full RLS policies

## Running

```bash
npm run dev       # Start dev server (port 5000)
npm run db:push   # Sync schema to DB
```
