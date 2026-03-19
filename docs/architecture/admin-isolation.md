# Admin Domain Isolation

**Platform**: blissops.com — AI Builder Platform  
**Phase**: Final Hardening Closeout  
**Last updated**: 2026-03-19

---

## 1. Admin Surface Definition

| Property | Value |
|---|---|
| Canonical host | `admin.blissops.com` |
| Admin path prefixes | `/ops/*`, `/api/admin/*` |
| Indexed | ❌ No — `X-Robots-Tag: noindex, nofollow` |
| Auth required | ✅ Yes — platform superadmin role |
| Shared deployment | ✅ Same SPA as `app.blissops.com` (current) |
| Physical isolation | ⏳ Deferred — Cloudflare Worker routing planned |

---

## 2. Domain Role Enforcement

**Middleware**: `server/middleware/admin-domain.ts`

```
request to /ops/* or /api/admin/*
  │
  ├─ host == admin.blissops.com → continue (production)
  ├─ host == localhost/dev host  → continue (dev bypass)
  └─ any other host              → 403 HOST_NOT_ALLOWED
```

The guard is applied **before** role checks. If the host is wrong, the request never reaches business logic.

**`isAdminPath(path)`** helper:
- Returns true for `/ops`, `/ops/*`, `/api/admin`, `/api/admin/*`
- All other paths are not admin-gated by this middleware

---

## 3. Access Control Model

Two-layer guard:

| Layer | Mechanism | Purpose |
|---|---|---|
| Host guard | `adminDomainGuard` middleware | Ensure request comes from admin host |
| Role guard | Existing session + role check | Ensure actor has superadmin role |

Both layers must pass for admin access. Failure at either = 403.

**Current state**: Host guard is implemented. Role guard relies on existing Express middleware chain (`isAdmin` / platform role checks on admin routes). These must not be weakened.

---

## 4. SEO / Indexing Safety

Admin domain must never be indexed.

**Mechanisms**:
1. `adminNoindexHeader` middleware sets `X-Robots-Tag: noindex, nofollow` on all responses from `admin.blissops.com`
2. `seo-rules.ts` in Phase 49 marks `admin.blissops.com` as `indexed: false`
3. Cloudflare Page Rules (planned): block crawler access at edge

**robots.txt**:
If a `robots.txt` is served on `admin.blissops.com`, it must contain:
```
User-agent: *
Disallow: /
```

---

## 5. Cookie / Session Model

Admin shares the Supabase session cookie with `app.blissops.com`:

| Property | Value |
|---|---|
| Session scope | `app.blissops.com` (not `.blissops.com`) |
| Cross-subdomain sharing | Supabase session does NOT cross to `admin.blissops.com` with current scope |
| Current workaround | Admin is currently served as `/ops/*` paths on `app.blissops.com` deployment |

**Important**: Because the session cookie is scoped to `app.blissops.com`, a direct navigation to `admin.blissops.com` in a future isolated deployment will require:
1. A token handoff mechanism (e.g. short-lived auth token from app → admin)
2. Or re-scoping the session cookie to `.blissops.com` (root domain)

**For current shared deployment**: No change needed. The admin host routes to the same Vercel deployment that serves `app.blissops.com`, so session cookies work correctly.

---

## 6. Response Hardening

Admin-specific headers added by `adminNoindexHeader`:

| Header | Value | Purpose |
|---|---|---|
| `X-Robots-Tag` | `noindex, nofollow` | Block search engine indexing |

All other security headers (HSTS, CSP, X-Frame-Options, etc.) are already set by the app-level helmet + response-security middleware from Phase 44. These apply to admin traffic too.

---

## 7. Non-Production Behavior

In non-production environments (development, preview):
- Host guard is bypassed (allows localhost, *.replit.dev, etc.)
- Admin routes are still role-guarded
- Noindex header is still set (never want admin indexed anywhere)

---

## 8. Future Isolation Roadmap

When admin traffic warrants physical isolation:

1. Create separate Vercel project for admin
2. Attach `admin.blissops.com` to admin project only
3. Implement session token handoff (short-lived cross-domain token)
4. Re-scope admin Supabase project or use service token
5. Deploy Cloudflare Worker to route `admin.blissops.com` to admin origin

Until then, shared deployment with domain-role enforcement is the accepted baseline.
