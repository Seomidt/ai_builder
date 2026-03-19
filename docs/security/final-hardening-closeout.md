# Final Hardening Closeout

**Platform**: blissops.com — AI Builder Platform  
**Phase**: Final Hardening Closeout  
**Date**: 2026-03-19  
**Status**: PLATFORM BASELINE: FULLY READY ✅

---

## 1. Host Allowlist Model

**File**: `server/middleware/host-allowlist.ts`  
**Config**: `server/lib/platform/platform-hardening-config.ts`

### Production allowed hosts

| Host | Role |
|---|---|
| `blissops.com` | Public marketing |
| `app.blissops.com` | Authenticated SPA |
| `admin.blissops.com` | Admin/ops console |

### Behavior by environment

| Environment | Canonical hosts | Localhost / Replit | Preview (*.vercel.app) |
|---|---|---|---|
| `production` | ✅ Allowed | ❌ Rejected | ❌ Rejected |
| `development` | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| `preview` | ✅ Allowed | ✅ Allowed | ✅ Allowed |

### What is rejected

- Any hostname not in the production allowed set during `NODE_ENV=production`
- `*.vercel.app` hostnames in production
- `*.replit.dev` / `*.repl.co` hostnames in production

### Health check bypass

Paths `/`, `/health`, `/healthz`, `/ping` always pass host validation (monitoring tools).

### Rejection behavior

- HTTP 403 with structured JSON error: `{ error_code: "HOST_NOT_ALLOWED" }`
- Host is logged via `console.warn` for diagnostics (not noisy in dev)

---

## 2. *.vercel.app / Preview Mitigation

Cloudflare cannot block requests to the raw `*.vercel.app` URL from within the `blissops.com` zone.

**Mitigation in place:**

| Layer | Mitigation |
|---|---|
| Host allowlist middleware | `*.vercel.app` rejected in production |
| Session cookies | Scoped to `app.blissops.com` — don't work on `.vercel.app` |
| Supabase allow-list | Only `app.blissops.com/auth/*` — auth fails on `.vercel.app` |
| No app code emits preview URLs | Verified via Phase 52 validation |
| HSTS | Browsers cache `app.blissops.com` as canonical |

**Not fully preventable:**  
A direct HTTP request to `*.vercel.app` bypasses the host allowlist (because the request never hits the production Express server through Cloudflare). The mitigation above ensures such access is functionally useless: no auth, no session, no canonical links.

---

## 3. Analytics Idempotency Model

**Schema**: `analytics_events.idempotency_key text` (nullable, unique where not null)  
**Migration**: `server/lib/analytics/migrate-phase50-idempotency.ts`  
**Tracking**: `server/lib/analytics/track-event.ts`  
**Config**: `ANALYTICS_DEDUPE_CONFIG` in `platform-hardening-config.ts`

### How it works

1. Caller provides an optional `idempotencyKey` when tracking an event
2. Server checks if a row with that key already exists before inserting
3. If duplicate found → silently skipped (no error, no duplicate)
4. If not found → inserted normally with the idempotency_key stored
5. Unique index on `idempotency_key WHERE idempotency_key IS NOT NULL` enforces DB-level dedup

### Events that should use idempotency keys

```
funnel.landing_view       → session-scoped (sessionId + date)
funnel.signup_started     → user-scoped (userId + date)
funnel.signup_completed   → user-scoped (userId)
billing.checkout_started  → checkout-scoped (checkoutId)
billing.checkout_completed → checkout-scoped (checkoutId)
ai.request_started        → request-scoped (requestId)
```

### Events where repeated ingestion is valid (no dedupe needed)

```
product.login             → each login is distinct
retention.daily_active    → triggered daily, not per-session
ai.request_completed      → distinct request IDs
ops.dashboard_viewed      → ops staff view many times
```

### Key format recommendations

```typescript
`signup_started:${userId}:${date}`       // user-scoped signup
`checkout:${checkoutSessionId}`           // Stripe-scoped checkout
`ai_req:${requestId}`                     // AI request-scoped
`session_start:${sessionId}`              // session-scoped
```

---

## 4. Admin Domain Isolation Rules

**File**: `server/middleware/admin-domain.ts`  
**Config**: `ADMIN_CONFIG` in `platform-hardening-config.ts`  
**Docs**: `docs/architecture/admin-isolation.md`

### Rules

| Rule | Implementation |
|---|---|
| Admin paths only from admin.blissops.com | `adminDomainGuard` middleware |
| `/ops/*` and `/api/admin/*` are admin paths | `isAdminPath()` helper |
| Public/app hosts → admin paths = 403 | `adminDomainGuard` returns 403 |
| Admin domain is noindex | `X-Robots-Tag: noindex, nofollow` via `adminNoindexHeader` |
| Local dev bypassed | Dev environments skip host check |
| Auth not broken | Guard only enforces host; role guard is separate |

### Session model

Admin uses the **same session** as `app.blissops.com` (shared deployment). This is intentional:
- Same Supabase auth session applies to both
- Role guard (superadmin check) provides the functional isolation
- When admin is physically isolated in a future phase, a session token handoff will be required

---

## 5. What Is Now Complete

| Area | Status |
|---|---|
| GitHub workflows + branching | ✅ Complete |
| Cloudflare Pro edge hardening | ✅ Complete |
| Supabase governance + RLS | ✅ Complete |
| Storage (R2 + tenant_files) | ✅ Complete |
| Disaster Recovery | ✅ Complete |
| i18n foundation | ✅ Complete |
| Domain architecture | ✅ Complete |
| Cloudflare ↔ Vercel origin setup | ✅ Complete |
| Analytics foundation | ✅ Complete |
| Host allowlist | ✅ Complete |
| Analytics idempotency | ✅ Complete |
| Admin domain isolation | ✅ Complete |
| Platform hardening config | ✅ Complete |

---

## 6. Intentionally Deferred (Non-blocking)

| Item | Reason |
|---|---|
| Physical admin subdomain isolation (separate Vercel project) | Shared deployment is acceptable until ops traffic warrants isolation |
| Vercel Access Protection on *.vercel.app previews | Low risk — auth + session mitigations already in place |
| Stream-based analytics processing | Batch rollups are sufficient until event volume requires real-time |
| PostHog or third-party product analytics | Phase 50 analytics foundation is sufficient for launch |
| Full SIEM integration | Security events layer is ready; SIEM wiring is post-launch |
| Phase 51 AI Ops Assistant | Ready to build — analytics + governance layer complete |
