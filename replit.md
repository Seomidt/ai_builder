# AI Builder Platform — V1

Internal control plane for AI-driven software generation built with Express + React + Drizzle ORM.

## Stack

- **Frontend**: React 19, Wouter (routing), TanStack Query, Shadcn UI, Tailwind CSS (dark navy theme)
- **Backend**: Express.js, TypeScript, Zod validation
- **Database**: PostgreSQL via Drizzle ORM
- **Architecture**: Repository → Service → Route handler pattern (strict layer separation)

## Project Structure

```
client/src/
  components/layout/   AppShell, Sidebar
  pages/               dashboard, projects, architectures, runs, integrations, settings
  lib/                 queryClient, utils

server/
  repositories/        projects, architectures, runs, integrations, knowledge
  services/            projects, architectures, runs, integrations
  routes.ts            Thin API handlers (delegate to storage → services → repositories)
  storage.ts           IStorage interface + DatabaseStorage implementation
  db.ts                Drizzle + pg connection pool

shared/
  schema.ts            All Drizzle tables, Zod insert schemas, TypeScript types
```

## Database Schema (17 tables)

| Domain | Tables |
|--------|--------|
| Identity | `profiles` |
| Multi-tenancy | `organizations`, `organization_members` |
| Projects | `projects` |
| Architectures | `architecture_profiles`, `architecture_versions`, `architecture_agent_configs`, `architecture_capability_configs`, `architecture_template_bindings`, `architecture_policy_bindings` |
| AI Runs | `ai_runs`, `ai_steps`, `ai_artifacts`, `ai_tool_calls`, `ai_approvals` |
| Integrations | `integrations`, `organization_secrets` |
| Knowledge (RAG prep) | `knowledge_documents` |

## Key Design Decisions

- **No hard delete**: `projects`, `architecture_profiles`, `ai_runs` use `status` field for archiving
- **Architecture versioning is first-class**: `current_version_id` on profiles, `is_published` + `publishedAt` on versions
- **AI Runs as lifecycle**: dedicated append operations for steps, artifacts, tool calls, approvals
- **Multi-tenancy**: `organization_id` only on top-level entities; child tables inherit via FK chain
- **Server-side secrets only**: GitHub/OpenAI tokens never reach the client
- **Default org**: `demo-org` used while Supabase Auth is not yet wired

## API Prefix

All routes: `/api/*`

## Running

```bash
npm run dev       # Start dev server
npm run db:push   # Push schema changes to DB
```

## Environment

See `.env.example` for all variables.
`DATABASE_URL` and `SESSION_SECRET` are the only required variables for local dev.
