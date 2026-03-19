# Domain and Origin Architecture

**Platform**: blissops.com — AI Builder Platform  
**Phase**: 52 — Cloudflare ↔ Vercel Origin Setup  
**Last updated**: 2026-03-19  
**Status**: ARCHITECTURE COMPLETE — Wiring Pending

---

## 1. Architecture Overview

```
User Browser
    │
    ▼ DNS lookup → Cloudflare (edge)
Cloudflare Zone: blissops.com
    │  - DDoS protection
    │  - TLS termination (Full Strict)
    │  - HTTPS redirect enforcement
    │  - www → apex redirect
    │  - Cache rules
    │  - Security headers (non-conflicting)
    │
    ▼ Proxy to origin (HTTPS)
Vercel Origin
    │  - Express backend (server/index.ts)
    │  - Vite frontend (client/)
    │  - API routes (/api/*)
    │  - Auth routes (/auth/*)
    │  - Admin/Ops routes (/ops/*)
    │
    ▼ DB + Auth
Supabase (PostgreSQL + Auth)
```

---

## 2. Cloudflare Role

Cloudflare operates as the **public edge** for all domains:

| Responsibility | Implementation |
|---|---|
| DNS authority | Cloudflare DNS zone for `blissops.com` |
| TLS termination | SSL mode: Full (Strict) |
| Always HTTPS | Cloudflare redirect rule (HTTP → HTTPS) |
| HSTS injection | Deferred to app layer — avoid duplication |
| www → apex redirect | Cloudflare Page Rule (301) |
| DDoS / WAF | Cloudflare managed rules |
| Cache | Static asset caching; dynamic BYPASS |
| Admin routing | Cloudflare Worker: routes `admin.blissops.com` → app origin |
| Origin masking | Cloudflare proxy (orange cloud) hides Vercel IP |

---

## 3. Vercel Role

Vercel operates as the **compute origin** behind Cloudflare:

| Responsibility | Implementation |
|---|---|
| Serve SPA | Vite build + Express static serving |
| Express API | All `/api/*` routes |
| Auth handling | All `/auth/*` routes (Supabase integration) |
| Admin/ops | All `/ops/*` routes (role-gated) |
| Build pipeline | Vercel CI/CD from GitHub |
| Preview deploys | `*.vercel.app` (internal only — not Supabase allow-listed) |

**Vercel origin exposure note:**  
The raw `*.vercel.app` URL cannot be fully blocked by Cloudflare. Mitigation:  
session cookies are scoped to `app.blissops.com`, Supabase allow-list excludes `.vercel.app`,  
and no application code emits preview URLs. See `cloudflare-vercel-origin-notes.md` for full analysis.

---

## 4. Canonical Hostnames

| Domain | Role | Indexed | Managed by |
|---|---|---|---|
| `blissops.com` | Public marketing (future) | ✅ | Cloudflare + Vercel |
| `www.blissops.com` | Redirect → apex | ❌ | Cloudflare (Page Rule) |
| `app.blissops.com` | Authenticated SPA | ❌ | Cloudflare + Vercel |
| `admin.blissops.com` | Admin/ops console | ❌ | Cloudflare Worker + Vercel |

Auth callbacks live exclusively on `app.blissops.com/auth/*`.  
No dedicated `auth.blissops.com` subdomain. Rationale: see `session-scope.ts`.

---

## 5. DNS Records Required

All records in Cloudflare zone `blissops.com`:

| Name | Type | Target | Proxy | Purpose |
|---|---|---|---|---|
| `@` | CNAME | `cname.vercel-dns.com` | ✅ ON | Public marketing (future) |
| `www` | CNAME | `blissops.com` | ✅ ON | www → apex redirect |
| `app` | CNAME | `cname.vercel-dns.com` | ✅ ON | Authenticated SPA |
| `admin` | CNAME | `cname.vercel-dns.com` | ✅ ON | Admin/ops |

---

## 6. TLS Model

| Setting | Value | Reason |
|---|---|---|
| SSL mode | **Full (Strict)** | Prevents MITM; Vercel always has valid cert |
| Always HTTPS | **ON** | HTTP requests redirect 301 to HTTPS |
| HSTS | Set at **app layer** (helmet) | `max-age=31536000; includeSubDomains; preload` |
| Minimum TLS | **TLS 1.2** (recommended: 1.3) | Modern browser compatibility |
| Certificate | Cloudflare Universal SSL + Vercel cert | Automatic renewal |

**⚠️ NEVER set SSL mode to Flexible** — Flexible sends traffic to Vercel over HTTP,  
causing the origin to receive HTTP while issuing HTTPS redirects = infinite loops.

---

## 7. Redirect Matrix

| Trigger | Action | Status Code | Owner |
|---|---|---|---|
| `http://app.blissops.com/*` | → `https://app.blissops.com/*` | 301 | Cloudflare |
| `http://admin.blissops.com/*` | → `https://admin.blissops.com/*` | 301 | Cloudflare |
| `http://blissops.com/*` | → `https://blissops.com/*` | 301 | Cloudflare |
| `https://www.blissops.com/*` | → `https://blissops.com/*` | 301 | Cloudflare |
| `https://blissops.com/` (exact) | → `https://blissops.com/en/` | 302 | Cloudflare (until Phase 50) |
| `https://admin.blissops.com/*` | Proxy to app origin via Worker | — | Cloudflare Worker |

**No redirect loop risk:**  
- SSL Full Strict: Cloudflare sends HTTPS to origin; app does not redirect back
- www rule is Cloudflare-only; app never receives www requests
- app/admin/root are separate subdomains; no circular routing

---

## 8. Cache Boundary

| Route | Cache | TTL | Reason |
|---|---|---|---|
| `/assets/*`, `*.js`, `*.css` | Cache | 1 year | Vite-hashed immutable |
| `*.woff2`, `*.png`, `*.svg` | Cache | 1 year | Static assets |
| `/api/*` | BYPASS | — | Auth-sensitive, dynamic |
| `/auth/*` | BYPASS | — | Callback flows, never cache |
| `/ops/*` | BYPASS | — | Real-time admin data |
| `/*.html`, SPA shell | BYPASS | — | Auth state varies per request |

---

## 9. Supabase Auth Host Assumptions

| Setting | Production Value |
|---|---|
| Site URL | `https://app.blissops.com` |
| Redirect URL (callback) | `https://app.blissops.com/auth/callback` |
| Redirect URL (invite) | `https://app.blissops.com/auth/invite-accept` |
| Redirect URL (email verify) | `https://app.blissops.com/auth/email-verify` |
| Redirect URL (reset) | `https://app.blissops.com/auth/password-reset-confirm` |
| Redirect URL (MFA) | `https://app.blissops.com/auth/mfa-challenge` |

**Must NOT be in production allow-list:**
- `http://localhost:*`
- `https://*.vercel.app/*`
- `https://*.replit.dev/*`
- `https://*.replit.app/*`

---

## 10. Vercel App Exposure Limitations

The `*.vercel.app` production URL **cannot be blocked** from Cloudflare's zone.  
Traffic to `ai-builder-xxx.vercel.app` bypasses Cloudflare entirely.

**Mitigation (already implemented):**
1. Session cookies scoped to `app.blissops.com` — auth fails on `.vercel.app`
2. Supabase allow-list excludes `.vercel.app` — OAuth/magic-link fails
3. No app code emits `.vercel.app` URLs (verified via Phase 52 validation)
4. HSTS on `app.blissops.com` caches canonical domain in browsers

**Vercel-side options (deferred):**
- Enable Vercel Access Protection on production deployment
- Password-protect Vercel preview deployments

---

## 11. Production vs Preview Domain Strategy

| Environment | Domain | Cloudflare Proxy | Notes |
|---|---|---|---|
| Production | `app.blissops.com` | ✅ | Canonical; HSTS; Supabase allow-listed |
| Preview | `*.vercel.app` | ❌ | Vercel-only; no auth; no session cookies |
| Development | `localhost:5000` | ❌ | Local only; DEMO_MODE=true |
| Replit preview | `*.replit.dev` | ❌ | Dev only; not Supabase allow-listed |

---

## 12. Security Headers Ownership

Headers set at **Express app layer** (Phase 44 — helmet + responseSecurityMiddleware):

| Header | App Layer | Cloudflare Action |
|---|---|---|
| `Strict-Transport-Security` | ✅ Set by helmet | Do NOT duplicate |
| `X-Frame-Options` | ✅ Set `DENY` | Do NOT duplicate |
| `X-Content-Type-Options` | ✅ Set `nosniff` | Do NOT duplicate |
| `Referrer-Policy` | ✅ Set | Do NOT duplicate |
| `Permissions-Policy` | ✅ Set | Do NOT duplicate |
| `Content-Security-Policy` | ✅ Set by helmet | Do NOT duplicate |

Cloudflare adds: `CF-Ray`, `CF-Cache-Status` — informational, not security headers.  
Cloudflare "Security Headers" managed transform must be **disabled** to avoid conflicts.

---

## 13. Phase 52 Execution Checklist

- [ ] Add CNAME records in Cloudflare: `app`, `admin`, `@`
- [ ] Attach `app.blissops.com` and `admin.blissops.com` in Vercel project settings
- [ ] Set SSL mode to **Full (Strict)** in Cloudflare
- [ ] Enable **Always HTTPS** in Cloudflare
- [ ] Create Page Rule: `www.blissops.com/*` → 301 → `https://blissops.com/$1`
- [ ] Deploy Cloudflare Worker for admin routing
- [ ] Update Supabase Site URL to `https://app.blissops.com`
- [ ] Update Supabase allow-list with production callback URLs only
- [ ] Remove localhost/preview URLs from production Supabase allow-list
- [ ] Disable Cloudflare "Security Headers" managed transform (app already sets headers)
- [ ] Configure Cloudflare Cache Rules (BYPASS for /api, /auth, /ops)
- [ ] Smoke test: login flow, auth callback, ops access, www redirect
- [ ] Verify HSTS header is served (not duplicated by Cloudflare)
- [ ] Verify `app.blissops.com` resolves and serves SPA
- [ ] Verify `admin.blissops.com` routes to `/ops`
