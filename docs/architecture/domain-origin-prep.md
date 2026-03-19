# Domain Origin Preparation — Phase 52 Readiness

**Platform**: blissops.com — AI Builder Platform  
**Phase**: 49 — Domain/Subdomain Architecture  
**Last updated**: 2026-03-19  
**Status**: READY FOR PHASE 52 WIRING

---

## Purpose

This document provides Phase 52 (Cloudflare ↔ Vercel origin wiring) with all architectural decisions already made.  
Phase 52 executes without re-deciding domain strategy.

---

## 1. Required DNS Targets (Cloudflare)

All DNS is managed via Cloudflare. Zone: `blissops.com`.

| Record | Type | Target | Proxy | Purpose |
|---|---|---|---|---|
| `blissops.com` | A / CNAME | Vercel public deployment | ✅ Proxied | Public marketing site |
| `www.blissops.com` | CNAME | `blissops.com` | ✅ Proxied | www → apex redirect |
| `app.blissops.com` | CNAME | Vercel app deployment | ✅ Proxied | Authenticated SPA |
| `admin.blissops.com` | CNAME | Vercel app deployment (same) | ✅ Proxied | Admin/ops surface |

> **Note**: `admin.blissops.com` initially points to the same Vercel deployment as `app.blissops.com`.  
> Routing isolation is handled by Cloudflare Workers (path prefix `/ops/*`).

---

## 2. Required Vercel Attached Custom Domains

| Domain | Deployment | Notes |
|---|---|---|
| `blissops.com` | Public marketing deployment | Separate from app |
| `app.blissops.com` | App (main) deployment | Primary SPA + backend |
| `admin.blissops.com` | App (main) deployment | Same deployment, isolated via Worker |

---

## 3. Cloudflare Redirect Rules

| Rule | Type | Source | Destination | Status Code |
|---|---|---|---|---|
| www redirect | Redirect | `www.blissops.com/*` | `https://blissops.com/$1` | 301 |
| Default locale redirect | Redirect | `blissops.com/` (exact) | `https://blissops.com/en/` | 302 |

---

## 4. Cloudflare Worker (Phase 52)

A lightweight Cloudflare Worker handles admin domain isolation:

```
Request to: admin.blissops.com/anything
→ Worker validates: path starts with / (anything)
→ Worker adds: header X-Domain-Role: admin
→ Worker forwards to: Vercel app deployment
→ App checks header and enforces superadmin RLS
```

**Why Worker, not separate deployment?**  
- Admin is currently the same codebase (`/ops/*` routes)  
- Worker adds zero latency to domain routing  
- Avoids maintaining two separate Vercel deployments until admin has its own build  

---

## 5. Expected Redirects (Cloudflare Page Rules / Redirect Rules)

| Trigger | Action | Status |
|---|---|---|
| `www.blissops.com` | Redirect to `blissops.com` | 301 Permanent |
| `blissops.com` (root, no locale) | Redirect to `blissops.com/en` | 302 Temporary until public site ships |
| `app.blissops.com/ops/*` | Serve normally (admin surface) | — |
| `admin.blissops.com/*` | Rewrite to `app.blissops.com/ops$path` | Worker |

---

## 6. Public / App / Admin / Auth Origin Mapping

| Domain | Origin Type | Deployment | Notes |
|---|---|---|---|
| `blissops.com` | Static / SSR | Vercel (public) | Separate from app. Locale-prefixed routes. |
| `app.blissops.com` | SPA + Express API | Vercel (app) | Vite frontend + Express backend |
| `admin.blissops.com` | SPA (same as app) | Vercel (app) | Same deployment, Worker-gated |
| `app.blissops.com/auth/*` | SPA routes | Vercel (app) | Supabase allow-listed |

---

## 7. Supabase Auth Configuration (Pre-Wiring Checklist)

Supabase project allow-list must include:

```
https://app.blissops.com/auth/callback
https://app.blissops.com/auth/invite-accept
https://app.blissops.com/auth/email-verify
https://app.blissops.com/auth/password-reset-confirm
https://app.blissops.com/auth/mfa-challenge
```

**⚠️ NEVER add**:
- `https://blissops.com/auth/*` — public domain must not handle auth
- `https://admin.blissops.com/auth/*` — admin must not handle auth
- Locale-prefixed auth paths (e.g. `/en/auth/callback`)

---

## 8. Cookie Domain Strategy (Pre-Wiring)

Phase 52 must configure cookies as follows:

| Cookie | Domain Attribute | SameSite | Secure |
|---|---|---|---|
| Supabase session | `app.blissops.com` | Lax | ✅ |
| CSRF token | `app.blissops.com` | Strict | ✅ |
| Locale preference | `.blissops.com` | Lax | ✅ |

---

## 9. robots.txt / Security Headers

Each deployment must serve the correct robots.txt:

| Domain | robots.txt |
|---|---|
| `blissops.com` | `Allow: /` + sitemap reference |
| `app.blissops.com` | `Disallow: /` |
| `admin.blissops.com` | `Disallow: /` |

Security headers required on all domains (Cloudflare Transform Rules):
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `Content-Security-Policy: default-src 'self'; ...` (expanded per deployment)

---

## 10. Phase 52 Execution Order

1. **DNS**: Add CNAME records in Cloudflare for `app.blissops.com` + `admin.blissops.com`
2. **Vercel**: Attach `app.blissops.com` and `admin.blissops.com` as custom domains
3. **Worker**: Deploy admin isolation Worker
4. **Redirects**: Configure www → apex and root → `/en/` redirect rules
5. **Supabase**: Update allow-list with production callback URLs
6. **Cookies**: Verify `app.blissops.com` scope in Supabase config
7. **Headers**: Enable security headers via Cloudflare Transform Rules
8. **Smoke test**: Verify auth callbacks, app login, ops access, www redirect

---

## 11. Architecture Decisions Summary (Phase 49)

| Decision | Choice | Rationale |
|---|---|---|
| Auth domain | `app.blissops.com` | Supabase allow-list simplicity; same token scope |
| Admin isolation | Cloudflare Worker | No second deployment needed until admin has own build |
| www redirect | Cloudflare Page Rule | Standard apex redirect |
| Cookie scope | `app.blissops.com` (privileged), `.blissops.com` (locale) | Security principle of minimal scope |
| Locale strategy | Hybrid (prefix=public, cookie=app) | SEO-safe for public; simpler for authenticated SPA |

---

*This document is the single source of truth for Phase 52 wiring decisions.*  
*Do not modify without updating Phase 52 task specification.*
