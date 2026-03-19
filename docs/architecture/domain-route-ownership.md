# Domain Route Ownership

**Platform**: blissops.com — AI Builder Platform  
**Phase**: 49 — Domain/Subdomain Architecture  
**Last updated**: 2026-03-19  
**Status**: ACTIVE

---

## Overview

This document classifies every current and planned route into its target domain surface.  
It is the authoritative reference for Phase 52 (Cloudflare ↔ Vercel origin wiring).

---

## Domain Summary

| Domain | Role | Indexed | Locale Strategy |
|---|---|---|---|
| `blissops.com` | Public marketing | ✅ Yes | URL-prefixed (`/en/`, `/da/`) |
| `app.blissops.com` | Authenticated SPA | ❌ No | Cookie-based |
| `admin.blissops.com` | Ops/admin console | ❌ No | Default only |
| `app.blissops.com/auth/*` | Auth callbacks | ❌ No | Locale-neutral |

---

## Route Classification

### 1. Public Routes — `blissops.com`

> Not yet built. Planned for Phase 50+.  
> These routes must NEVER be served from `app.blissops.com` long-term.

| Route Pattern | Status | Notes |
|---|---|---|
| `/` | Planned | Homepage / hero |
| `/en/`, `/da/` | Planned | Locale-prefixed entry |
| `/en/pricing`, `/da/pricing` | Planned | Pricing page |
| `/en/about`, `/da/about` | Planned | About page |
| `/en/legal/*`, `/da/legal/*` | Planned | Legal/terms |
| `/en/blog/*`, `/da/blog/*` | Planned | Content marketing |
| `/sitemap.xml` | Planned | XML sitemap |
| `/robots.txt` | Planned | Must allow `/` |

### 2. App Routes — `app.blissops.com`

> Currently served from monolithic SPA. Target: isolated to `app.blissops.com`.

| Route Pattern | Surface | Auth Required | Notes |
|---|---|---|---|
| `/` | App | ✅ | Dashboard / redirect to `/projects` |
| `/projects` | App | ✅ | Projects list |
| `/architectures` | App | ✅ | Architecture list |
| `/runs` | App | ✅ | Run list |
| `/runs/:id` | App | ✅ | Run detail |
| `/integrations` | App | ✅ | Integrations |
| `/settings` | App | ✅ | User settings |
| `/settings/security` | App | ✅ | Security settings |

### 3. Auth Routes — `app.blissops.com/auth/*`

> Locale-neutral. Must remain on `app.blissops.com`.  
> Registered in Supabase redirect allow-list.

| Route Pattern | Auth Required | Notes |
|---|---|---|
| `/auth/login` | ❌ | Login page |
| `/auth/password-reset` | ❌ | Request password reset |
| `/auth/password-reset-confirm` | ❌ | Confirm with token |
| `/auth/email-verify` | ❌ | Email verification callback |
| `/auth/invite-accept` | ❌ | Org invite accept |
| `/auth/mfa-challenge` | Partial | MFA step (after primary auth) |
| `/auth/callback` | ❌ | OAuth / magic link / Supabase callback |

**⚠️ RULE**: Auth routes must NEVER be locale-prefixed.  
**⚠️ RULE**: Auth routes must NEVER move to `admin.blissops.com` or `blissops.com`.

### 4. Admin / Ops Routes — `admin.blissops.com`

> Currently served under `/ops/*` in the same SPA.  
> Target: isolated to `admin.blissops.com` via Cloudflare routing (Phase 52).

| Route Pattern | Surface | Auth Required | Role Required |
|---|---|---|---|
| `/ops` | Admin | ✅ | superadmin |
| `/ops/tenants` | Admin | ✅ | superadmin |
| `/ops/jobs` | Admin | ✅ | superadmin |
| `/ops/webhooks` | Admin | ✅ | superadmin |
| `/ops/ai` | Admin | ✅ | superadmin |
| `/ops/billing` | Admin | ✅ | superadmin |
| `/ops/recovery` | Admin | ✅ | superadmin |
| `/ops/security` | Admin | ✅ | superadmin |
| `/ops/assistant` | Admin | ✅ | superadmin |
| `/ops/release` | Admin | ✅ | superadmin |
| `/ops/auth` | Admin | ✅ | superadmin |
| `/ops/storage` | Admin | ✅ | superadmin |

**⚠️ RULE**: Admin routes must NEVER be publicly accessible.  
**⚠️ RULE**: Admin routes must NEVER be indexed.

### 5. API Routes — Internal

> Served by Express backend. Must not be locale-prefixed.  
> Not publicly accessible from external domains.

| Route Pattern | Surface | Auth Required |
|---|---|---|
| `/api/*` | API / internal | Varies |
| `/api/auth/*` | Auth API | No |
| `/api/admin/*` | Admin API | ✅ superadmin |

---

## Helper Functions

These are implemented in `client/src/lib/domain/config.ts`:

```typescript
import { resolveDomainRoleFromPath, assertRouteOwnedByDomain } from "./config";
```

### `resolveDomainRoleFromPath(path: string): DomainRole`

| Path prefix | Resolved role |
|---|---|
| `/ops/*` | `admin` |
| `/auth/*` | `auth` |
| `/api/*` | `app` (internal) |
| Anything else | `app` |

### `assertRouteOwnedByDomain(path, expectedRole)`

Throws if the resolved role does not match the expected domain.  
Used in Phase 52 origin wiring checks.

---

## Current vs. Target State

| Surface | Current State | Target State (Phase 52+) |
|---|---|---|
| `blissops.com` | Not served (redirects or raw host) | Vercel/static deployment |
| `app.blissops.com` | All routes (monolith) | App routes only |
| `admin.blissops.com` | Not wired (same as app) | Isolated via Cloudflare routing |
| Auth callbacks | `/auth/*` in same SPA | Same — remains on `app.blissops.com` |

---

## Boundary Rules

1. Public pages (`blissops.com`) must NOT be served from `app.blissops.com`
2. App routes (`app.blissops.com`) must NOT be crawlable
3. Admin routes (`admin.blissops.com`) must NEVER be public
4. Auth callbacks (`/auth/*`) must NEVER move domain
5. API routes (`/api/*`) must NEVER be locale-prefixed
6. `/ops/*` routes are admin surface — must carry noindex even before isolation
