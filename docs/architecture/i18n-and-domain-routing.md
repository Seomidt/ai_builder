# i18n Architecture and Domain Routing Strategy

**Platform**: blissops.com — AI Builder Platform  
**Phase**: 49 — Domain/Subdomain Architecture (supersedes Phase 48)  
**Last updated**: 2026-03-19  
**Status**: ACTIVE

---

## 1. Hybrid i18n Architecture

The platform uses a **hybrid locale strategy** because different surfaces have fundamentally different SEO and UX requirements.

| Surface | Domain | Locale Strategy | Reason |
|---|---|---|---|
| Public marketing | `blissops.com` | URL-prefixed (`/en/`, `/da/`) | SEO-critical; crawlers need locale-explicit URLs |
| Authenticated app | `app.blissops.com` | Cookie-based (`blissops_locale`) | SPA; no SSR; locale is per-user preference |
| Admin/ops | `admin.blissops.com` | Default locale only | Internal tool; no locale switching needed now |
| Auth callbacks | `app.blissops.com/auth/*` | Locale-neutral | Supabase callbacks must have stable, prefix-free paths |

---

## 2. Public Domain — Locale-Prefixed URLs

```
blissops.com/en/         → English homepage
blissops.com/da/         → Danish homepage
blissops.com/en/pricing  → English pricing page
blissops.com/da/pricing  → Danish pricing page
```

### Canonical tags
Every public page must declare a canonical URL with the locale prefix:
```html
<link rel="canonical" href="https://blissops.com/en/pricing" />
```

### hreflang tags
Every public page must include hreflang for all supported locales:
```html
<link rel="alternate" hreflang="en"        href="https://blissops.com/en/pricing" />
<link rel="alternate" hreflang="da"        href="https://blissops.com/da/pricing" />
<link rel="alternate" hreflang="x-default" href="https://blissops.com/en/pricing" />
```

### Default locale redirect (public)
```
blissops.com/  →  302  →  blissops.com/en/
```
302 (not 301) until public site ships — easier to change redirect target.

### www redirect
```
www.blissops.com/*  →  301  →  blissops.com/*
```

---

## 3. App Domain — Cookie-Based Locale

The authenticated SPA (`app.blissops.com`) resolves locale via a priority chain:

```
1. Explicit selection (user clicked locale switcher)
2. User preference  (stored in user profile)
3. Tenant preference (org-level default locale)
4. Cookie          (blissops_locale — persisted from previous selection)
5. Browser header  (navigator.languages)
6. Default         (en)
```

### Why cookie-based for app?

| Factor | Decision |
|---|---|
| Stack | Vite + React + Wouter (SPA, no SSR) |
| Auth | Supabase callbacks use fixed `/auth/*` paths — prefixing breaks them |
| API routes | Express REST (`/api/*`) must not be locale-prefixed |
| User base | B2B SaaS — locale is per-user preference, not per-shared URL |
| SEO | Authenticated app is noindex — SEO locale variants not needed |

### Cookie config
```
Name:      blissops_locale
Domain:    .blissops.com  (benign cross-subdomain — public also gets locale pref)
Expires:   1 year
SameSite:  Lax
Secure:    true (production)
```

---

## 4. Admin Domain — Default Locale

`admin.blissops.com` uses the default locale (`en`) only.

- No locale switcher in ops console
- No locale cookie written from admin surface
- Future expansion: add `localeStrategy: "cookie"` to `DOMAIN_CONFIGS[DOMAIN_ROLE.ADMIN]` and expose LocaleSwitcher

---

## 5. Auth / Callback Flows — Locale-Neutral

Auth callback paths are **locale-neutral** by design:

```
app.blissops.com/auth/login
app.blissops.com/auth/callback
app.blissops.com/auth/invite-accept
app.blissops.com/auth/email-verify
app.blissops.com/auth/password-reset-confirm
app.blissops.com/auth/mfa-challenge
```

**Rules:**
- NEVER prefix with `/en/` or `/da/`
- NEVER move to `admin.blissops.com` or `blissops.com`
- ALWAYS remain on `app.blissops.com`
- Post-callback redirect lands on app route (e.g. `/` or `/settings`)

---

## 6. Supported Locales

| Code | Language | Native Name |
|---|---|---|
| `en` | English | English |
| `da` | Danish | Dansk |

**Default locale**: `en`  
**Cookie name**: `blissops_locale`

### Adding a new locale (checklist)
1. Add to `SUPPORTED_LOCALES` in `client/src/lib/i18n/config.ts`
2. Create `client/src/locales/[locale]/` with all 5 namespace files
3. Verify key parity with `en` (validation script enforces this)
4. Add to sitemap generator (Phase 50+)
5. Add hreflang entries to public pages (Phase 50+)

---

## 7. Translation Namespaces

5 namespaces, loaded lazily per namespace:

| Namespace | Coverage |
|---|---|
| `common` | Navigation, actions, status, errors, brand |
| `auth` | Login, logout, MFA, password reset, invite |
| `dashboard` | Stats, project/run summaries |
| `settings` | Profile, security, language preferences |
| `ops` | Admin console, tenants, jobs, AI governance |

---

## 8. URL Builders

All cross-domain URLs must be generated via:

```typescript
import {
  buildPublicUrl,
  buildLocalePublicUrl,
  buildAppUrl,
  buildAdminUrl,
  buildAuthUrl,
  buildInviteUrl,
  buildResetPasswordUrl,
  buildMagicLinkReturnUrl,
} from "@/lib/domain/url-builders";
```

No hardcoded hostnames should appear elsewhere in the codebase after Phase 49.

---

## 9. Domain Model Files

Full domain architecture is defined in:
- `client/src/lib/domain/config.ts` — roles, hostnames, predicates
- `client/src/lib/domain/canonical.ts` — canonical URL helpers
- `client/src/lib/domain/session-scope.ts` — cookie/session strategy
- `client/src/lib/domain/seo-rules.ts` — robots/indexing rules
- `client/src/lib/domain/url-builders.ts` — typed URL builders

Route ownership: `docs/architecture/domain-route-ownership.md`  
Phase 52 prep: `docs/architecture/domain-origin-prep.md`

---

## 10. Future Migration Path

When public marketing pages are added (Phase 50+):

1. Public site is a separate Vercel deployment (or static export)
2. Public site uses locale-prefixed routing from the start
3. App SPA remains on cookie-based locale — no migration needed
4. `blissops.com` and `app.blissops.com` are isolated deployments behind Cloudflare
5. All helpers in `locale-path.ts` and `url-builders.ts` already support this

When admin isolation ships (Phase 52):
1. Cloudflare Worker routes `admin.blissops.com/*` to `/ops/*` on app deployment
2. Worker sets `X-Domain-Role: admin` header
3. App checks header and enforces superadmin gating
4. Cookie scope remains `app.blissops.com` until admin gets own deployment
