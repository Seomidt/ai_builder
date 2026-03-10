# AI Builder Platform — V1 (Phase 1.1)

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
  lib/                 supabase.ts (admin client), github.ts (token helpers)
  middleware/          auth.ts (JWT → req.user)
  repositories/        projects, architectures, runs, integrations, knowledge
  services/            projects, architectures, runs, integrations
  routes.ts            Thin API handlers
  storage.ts           IStorage + DatabaseStorage
  db.ts                Drizzle + pg pool

shared/
  schema.ts            All Drizzle tables + insert schemas + TypeScript types
```

## Database Schema (17 tables)

| Domain | Tables |
|--------|--------|
| Identity | `profiles` |
| Multi-tenancy | `organizations`, `organization_members` |
| Projects | `projects` (+ github_owner, github_repo, github_default_branch, github_repo_url) |
| Architectures | `architecture_profiles`, `architecture_versions`, `architecture_agent_configs`, `architecture_capability_configs`, `architecture_template_bindings`, `architecture_policy_bindings` |
| AI Runs | `ai_runs` (+ goal, pipeline_version), `ai_steps` (+ title, description, tags), `ai_artifacts` (+ description, path, version, tags), `ai_tool_calls`, `ai_approvals` |
| Integrations | `integrations`, `organization_secrets` |
| Knowledge (RAG prep) | `knowledge_documents` |

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
