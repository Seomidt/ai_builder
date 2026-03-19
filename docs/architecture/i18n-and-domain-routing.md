# i18n Architecture and Domain Routing Strategy

**Platform**: blissops.com — AI Builder Platform  
**Phase**: 48 — Internationalization Foundation  
**Last updated**: 2026-03-19  
**Status**: ACTIVE

---

## 1. Chosen Locale Routing Strategy

### Strategy: Cookie-based locale (no URL prefix)

The platform uses **cookie-based locale persistence** without locale-prefixed URLs.

```
Current: /dashboard       (locale determined by cookie, not URL)
NOT:     /da/dashboard    (locale-prefixed — not currently active)
```

### Why this strategy was chosen

| Factor | Decision |
|---|---|
| Stack | Vite + React + Wouter (SPA, no SSR) |
| Auth | Supabase callbacks use fixed paths (`/auth/...`) — prefixing breaks them |
| API routes | Express REST API paths (`/api/...`) must not be locale-prefixed |
| User base | B2B SaaS — locale set per user/tenant, not per URL share |
| SEO | Internal app (authenticated) — SEO locale variants not required now |
| Simplicity | Cookie is simpler, avoids router complexity in Wouter |

### Future upgrade path (Phase 50+)
When public marketing pages are added, locale-prefixed URLs can be introduced:
- Public: `/en/`, `/da/` with proper hreflang
- App: remains cookie-based OR migrates to `/[locale]/...` with a layout wrapper
- All helpers in `locale-path.ts` are built to support this upgrade transparently

---

## 2. Supported Locales

| Code | Language | Native | Default |
|---|---|---|---|
| `en` | English | English | ✅ Yes |
| `da` | Danish | Dansk | No |

**Default locale**: `en`  
Adding a new locale requires:
1. Add to `SUPPORTED_LOCALES` in `config.ts`
2. Add metadata to `LOCALE_METADATA`
3. Create locale directory: `client/src/locales/[locale]/`
4. Create all namespace JSON files
5. Update translations

---

## 3. Locale Resolution Priority

```
1. Explicit override (programmatic, e.g. force English for system routes)
2. User preference (from auth profile — future-ready hook)
3. Tenant default locale (future-ready hook in resolveTenantLocale())
4. Cookie: blissops_locale (set on language switch, 1-year expiry)
5. Browser Accept-Language header (navigator.languages)
6. Platform default: "en"
```

This is implemented in `client/src/lib/i18n/resolve-locale.ts`.

---

## 4. Translation Dictionary Structure

```
client/src/locales/
  en/
    common.json      ← shared: nav, actions, status, errors, time
    auth.json        ← login, logout, mfa, password reset
    dashboard.json   ← stats, sections, empty states
    settings.json    ← profile, security, language preferences
    ops.json         ← ops console, tenants, jobs, security, storage
  da/
    common.json
    auth.json
    dashboard.json
    settings.json
    ops.json
```

**Namespace loading**: lazy-loaded per namespace via Vite glob imports.  
**Cache**: in-process Map, cleared on locale switch.  
**Fallback**: missing key → fallback locale (en) → key name itself (dev warning).

---

## 5. Architecture Files

| File | Purpose |
|---|---|
| `client/src/lib/i18n/config.ts` | Types, supported locales, helpers |
| `client/src/lib/i18n/resolve-locale.ts` | Resolution priority chain + cookie utils |
| `client/src/lib/i18n/load-dictionary.ts` | Async namespace loader with caching |
| `client/src/lib/i18n/translator.ts` | `createTranslator`, interpolation, pluralization |
| `client/src/lib/i18n/locale-path.ts` | Path helpers: withLocale, stripLocale, replaceLocale |
| `client/src/components/providers/I18nProvider.tsx` | React context + hooks |
| `client/src/hooks/use-translations.ts` | `useTranslations(ns)` hook |
| `client/src/components/i18n/LocaleSwitcher.tsx` | Accessible locale switcher |

---

## 6. Core Shell Migration

The following areas were migrated in Phase 48:

| Component | Namespace | Keys migrated |
|---|---|---|
| `Sidebar.tsx` | `common` | nav.*, brand.name |
| `App.tsx` | — | Wrapped with I18nProvider |

Future migrations (Phase 49+):
- `pages/dashboard.tsx` → dashboard namespace
- `pages/settings.tsx` → settings namespace
- `pages/ops/*.tsx` → ops namespace
- Auth pages → auth namespace

---

## 7. Domain Structure (Future Phase 50+)

Recommended future domains:

```
blissops.com          → Public marketing site (Next.js or Astro, locale-prefixed)
app.blissops.com      → Authenticated app (current, cookie-based locale)
admin.blissops.com    → Internal ops console (admin-only, en-only initially)
auth.blissops.com     → Supabase auth callbacks (no locale prefix, system routes)
```

### Locale interactions with subdomains

| Domain | Locale strategy | Cookie scope |
|---|---|---|
| `blissops.com` | URL prefix (`/en/`, `/da/`) | `.blissops.com` |
| `app.blissops.com` | Cookie | `.blissops.com` (shared) |
| `admin.blissops.com` | Cookie or fixed `en` | Separate |
| `auth.blissops.com` | None (system routes) | None |

### Cookie cross-subdomain note
Set `Domain=.blissops.com` (leading dot) to share locale cookie across subdomains.
Currently set to current domain only (Phase 48 scope).

---

## 8. Email / System Message i18n (Future Phase 51+)

Planned approach:
- Server-side: `loadDictionary(tenantLocale, "emails")` using the same loader
- Template: Handlebars or similar with `{{t "greeting" name=recipientName}}`
- Locale source: `tenant.default_locale` → `user.locale_preference` → `"en"`
- Namespace: `client/src/locales/[locale]/emails.json` (add when needed)

---

## 9. Pluralization

Currently implemented as a placeholder in `translator.ts`:
- `t.plural(key, { count: n })` → uses `key_one` / `key_other` suffixes
- Full CLDR plural rules (Czech, Polish etc.) can be added via `Intl.PluralRules`

---

## 10. Validation

Phase 48 validation: `scripts/validate-phase48.ts`  
60 scenarios, 250+ assertions covering:
- Config correctness
- Dictionary integrity
- Translator logic
- Path helpers
- Cookie utilities
- Component existence
- Core shell migration

---

*blissops.com AI Builder Platform — i18n Architecture*  
*Classification: INTERNAL*
