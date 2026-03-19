# UI Enablement Report

## Backend Capability Inventory

### Auth / Session
- Supabase Auth (login, logout, MFA, password reset, email verify)
- Lockdown mode (allowlist-based access control)
- Session validation middleware
- Invite accept flow

### Tenant
- Tenant dashboard metrics (projects, runs, integrations)
- AI runs (paginated list, start new run)
- Usage monitoring (tokens in/out, cost, daily trends by period)
- Billing / budget visibility (monthly budget, soft/hard limits, utilization)
- Audit log (event timeline, search, pagination)
- Team management (members, invite, roles)
- Tenant settings (locale, preferences)
- File/storage metadata

### Admin / Ops
- Platform health summary (`/api/admin/ai-ops/health-summary`)
- Weekly AI digest (`/api/admin/ai-ops/weekly-digest`)
- AI Ops audit log (`/api/admin/ai-ops/audit`)
- AI governance: budget check for all tenants
- AI governance: anomaly detection
- AI governance: alert generation and listing
- AI governance: runaway protection
- Tenant listing (`/api/admin/tenants`)
- Plans listing (`/api/admin/plans`)
- Invoice listing (`/api/admin/invoices`)
- Security health (`/api/admin/security/health`)
- Security events / recent events
- Deploy health / env checks (`/api/admin/platform/deploy-health`)
- Storage file listing (`/api/storage`)
- Analytics ingestion + rollups (`/api/admin/analytics/summary`)

---

## UI Surface Mapping

| Capability | Surface | Page | API Endpoint | Role |
|---|---|---|---|---|
| Platform health + digest | Admin UI | `/ops` | `/api/admin/ai-ops/health-summary`, `/api/admin/ai-ops/weekly-digest` | admin |
| Tenant list | Admin UI | `/ops/tenants` | `/api/admin/tenants` | admin |
| AI governance (budgets, alerts, audit) | Admin UI | `/ops/ai` | `/api/admin/governance/*`, `/api/admin/ai-ops/audit` | admin |
| Plans + invoices | Admin UI | `/ops/billing` | `/api/admin/plans`, `/api/admin/invoices` | admin |
| Deploy health + env checks | Admin UI | `/ops/release`, `/ops/recovery` | `/api/admin/platform/deploy-health` | admin |
| Security events + posture | Admin UI | `/ops/security` | `/api/admin/security/health`, `/api/admin/security/events/recent` | admin |
| Auth security posture | Admin UI | `/ops/auth` | `/api/admin/security/health`, `/api/admin/security/events/recent` | admin |
| Storage file metadata | Admin UI | `/ops/storage` | `/api/storage` | admin |
| AI Ops assistant | Admin UI | `/ops/assistant` | `/api/admin/ai-ops/query` | admin |
| Background jobs | Admin UI | `/ops/jobs` | — (deferred) | admin |
| Webhooks | Admin UI | `/ops/webhooks` | — (deferred) | admin |
| Tenant dashboard | Tenant UI | `/tenant` | `/api/tenant/dashboard` | tenant |
| AI runs | Tenant UI | `/tenant/ai` | `/api/tenant/ai/runs` | tenant |
| Usage monitoring | Tenant UI | `/tenant/usage` | `/api/tenant/usage` | tenant |
| Budget / billing | Tenant UI | `/tenant/billing` | `/api/tenant/billing` | tenant |
| Audit log | Tenant UI | `/tenant/audit` | `/api/tenant/audit` | tenant |
| Team management | Tenant UI | `/tenant/team` | `/api/tenant/team` | tenant |
| Settings | Tenant UI | `/tenant/settings` | `/api/tenant/settings` | tenant |
| Data / files | Tenant UI | `/tenant/data` | (in progress) | tenant |
| Integrations | Tenant UI | `/tenant/integrations` | (in progress) | tenant |

---

## Gap Analysis

### Closed in this phase
1. `ops/dashboard` — backend health + weekly digest now wired
2. `ops/tenants` — tenant list query now wired
3. `ops/ai` — governance alerts, budgets, audit now wired + action button
4. `ops/billing` — plans and invoices now wired
5. `ops/security` — security health + recent events now wired
6. `ops/auth` — auth posture + auth events now wired
7. `ops/storage` — storage file list now wired
8. `ops/recovery` — deploy health checks now wired
9. `ops/release` — deploy health checks now wired (refreshable)

### Hidden / Deferred (intentional)
- `ops/jobs` — no job queue backend exists yet (Inngest/BullMQ not integrated)
- `ops/webhooks` — no outbound webhook system exists yet

### Remaining product gaps (next phase)
- `tenant/data` — file upload/listing not fully wired from tenant side
- `tenant/integrations` — integration health not fully wired
- Analytics UI surface (`/api/admin/analytics/summary`) not yet in a dedicated admin page
- Admin per-tenant drill-down (click tenant → see usage)
- Audit log for admin side (separate from AI-ops audit)

---

## Files Changed

### New / Modified (this phase)
- `client/src/pages/ops/dashboard.tsx` — full implementation
- `client/src/pages/ops/tenants.tsx` — full implementation
- `client/src/pages/ops/ai.tsx` — full implementation
- `client/src/pages/ops/billing.tsx` — full implementation
- `client/src/pages/ops/security.tsx` — full implementation
- `client/src/pages/ops/auth.tsx` — full implementation
- `client/src/pages/ops/storage.tsx` — full implementation
- `client/src/pages/ops/recovery.tsx` — full implementation
- `client/src/pages/ops/release.tsx` — full implementation
- `client/src/pages/ops/jobs.tsx` — explicit deferred state
- `client/src/pages/ops/webhooks.tsx` — explicit deferred state
- `docs/architecture/responsibility-map.md` — platform boundary contract
- `server/lib/env.ts` — required() env validation
- `docs/product/ui-enablement-report.md` — this file
- `scripts/validate-ui-enablement.ts` — validation script

### Already wired (tenant UI — no changes needed)
- `client/src/pages/tenant/dashboard.tsx` ✅
- `client/src/pages/tenant/ai.tsx` ✅
- `client/src/pages/tenant/usage.tsx` ✅
- `client/src/pages/tenant/billing.tsx` ✅
- `client/src/pages/tenant/audit.tsx` ✅
- `client/src/pages/tenant/team.tsx` ✅
- `client/src/pages/tenant/settings.tsx` ✅
