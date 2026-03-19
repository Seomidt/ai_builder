# PLATFORM RESPONSIBILITY MAP

## SUPABASE (SOURCE OF TRUTH)

Owns:
- Authentication (users, sessions)
- Tenants
- Memberships (user ↔ tenant ↔ role)
- Roles (platform_admin, coach, client)
- Domain data (programs, clients, checkins)
- AI usage + budgets
- Audit logs
- File metadata

Guarantees:
- Row Level Security (RLS)
- Tenant isolation
- Referential integrity

Never:
- Execute business logic
- Call external APIs
- Decide runtime access alone

---

## VERCEL (EXECUTION LAYER)

Owns:
- All API routes
- Auth validation (via Supabase session)
- Role + tenant enforcement
- AI orchestration
- Signed URL issuing
- Input validation
- Rate limiting (app-level)
- Middleware

Never:
- Store source-of-truth data
- Trust client input
- Bypass Supabase RLS

---

## CLOUDFLARE (EDGE LAYER)

Owns:
- DNS
- SSL (Full strict)
- WAF
- Rate limiting (edge)
- Bot protection
- Redirects
- Caching

Never:
- Handle auth logic
- Handle tenant logic
- Store business state

---

## FLOW OVERVIEW

```
Request →
Cloudflare (filter) →
Vercel (auth + logic) →
Supabase (data validation)
```
