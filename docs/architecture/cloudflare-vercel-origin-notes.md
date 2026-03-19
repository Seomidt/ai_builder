# Cloudflare ↔ Vercel Origin Architecture Notes

**Platform**: blissops.com — AI Builder Platform  
**Phase**: 52 — Connect Cloudflare → Vercel (Origin Setup)  
**Last updated**: 2026-03-19  
**Status**: ARCHITECTURE DEFINED — Pending Production Wiring

---

## 1. Current Audited State

| Property | Current Status |
|---|---|
| Production root domain | `blissops.com` (Cloudflare zone) |
| www behavior | Not yet configured — needs 301 redirect rule |
| App lives on | Replit dev server (`localhost:5000`) — not yet on `app.blissops.com` |
| Admin/ops | Same SPA as app — `/ops/*` routes, not yet isolated |
| Auth callbacks | `/auth/*` paths in SPA — using localhost during dev |
| i18n | Cookie-based on app; URL-prefix planned for public (not yet served) |
| Public pages | Not yet built — `blissops.com` serves nothing (or raw Replit host) |
| Vercel deployment | Not yet wired to custom domains |

---

## 2. Target State (Phase 52 Completes This)

| Domain | Origin | Status After Phase 52 |
|---|---|---|
| `blissops.com` | Vercel (marketing, future) | DNS record ready — deployment TBD Phase 50+ |
| `www.blissops.com` | Cloudflare redirect | 301 → apex |
| `app.blissops.com` | Vercel (main app) | CNAME → `cname.vercel-dns.com` |
| `admin.blissops.com` | Vercel (same as app) | CNAME → `cname.vercel-dns.com` |

---

## 3. Origin Lockdown — What Can and Cannot Be Blocked

### What CAN be done to prevent origin leakage:

1. **All canonical links use `app.blissops.com`**  
   Implemented via `buildAppUrl()`, `buildAdminUrl()`, `buildAuthUrl()` in `url-builders.ts`.  
   No hardcoded hostnames remain in application code.

2. **Auth callbacks registered exclusively on `app.blissops.com`**  
   Supabase allow-list must only include `https://app.blissops.com/auth/*`.  
   Documented in `AUTH_CALLBACK_PATHS` in `session-scope.ts`.

3. **No app code emits `*.vercel.app` or `*.replit.dev` URLs**  
   Verified: domain config, url-builders, and session-scope contain no preview/dev hostnames.

4. **Security headers served at app level (Phase 44)**  
   `securityHeaders` (helmet), `responseSecurityMiddleware` already in place.  
   Cloudflare edge headers must complement, not duplicate.

### What CANNOT be fully controlled from Cloudflare zone:

**`*.vercel.app` bypass is NOT preventable from the Cloudflare blissops.com zone.**

The raw Vercel deployment hostname (e.g. `ai-builder-xxxx.vercel.app`) is served  
directly from Vercel's infrastructure and does NOT route through the blissops.com  
Cloudflare zone. Therefore:

- Cloudflare Page Rules, Workers, and Transform Rules on `blissops.com` have **zero effect**  
  on requests to `ai-builder-xxxx.vercel.app`
- Blocking `*.vercel.app` from Cloudflare is **not possible** without Vercel's own access controls
- Vercel's "Password Protection" or "Vercel Access" feature can gate preview deployments,  
  but the production deployment URL (`.vercel.app`) cannot be blocked by Cloudflare

**Mitigation strategy (not a full block):**

1. Application enforces canonical domain via `buildAppUrl()` — no dev URLs emitted in code
2. Supabase allow-list is restricted to `app.blissops.com` only — auth via `.vercel.app` will fail
3. Cookies scoped to `app.blissops.com` — session cookies do not work on `.vercel.app`
4. CSP `connect-src` and `frame-ancestors` headers limit cross-origin exploitation
5. HSTS on `app.blissops.com` ensures browser caches the canonical domain
6. Document the `.vercel.app` URL internally and treat it as internal-only

**How bypass works technically:**  
Traffic to `ai-builder-xxx.vercel.app` bypasses Cloudflare entirely — it resolves directly to  
Vercel's Anycast infrastructure, never touching the blissops.com Cloudflare zone.  
Cloudflare has zero visibility into, and zero control over, requests that go to `*.vercel.app`.

**⚠️ TLS note — never set SSL to Flexible:**  
Cloudflare SSL mode must be **Full (Strict)** — never Flexible.  
Flexible SSL sends traffic from Cloudflare to the origin over plain HTTP, causing the origin  
to see HTTP while clients see HTTPS. This breaks HSTS and creates a security downgrade.

**Explicit acknowledgment:**  
*This platform cannot guarantee that a user cannot directly access the Vercel origin  
via `*.vercel.app`. The mitigation above ensures that such access is functionally  
limited: no auth sessions work, no canonical links point there, no SEO indexing occurs.*

---

## 4. Canonical Domain Enforcement in Application Code

All URL construction flows through `client/src/lib/domain/url-builders.ts`:

| Function | Returns | Hardcoded hostname? |
|---|---|---|
| `buildPublicUrl(path)` | `https://blissops.com/...` | No — via `ORIGINS.PUBLIC` |
| `buildLocalePublicUrl(locale, path)` | `https://blissops.com/en/...` | No |
| `buildAppUrl(path)` | `https://app.blissops.com/...` | No |
| `buildAdminUrl(path)` | `https://admin.blissops.com/...` | No |
| `buildAuthUrl(path)` | `https://app.blissops.com/auth/...` | No |
| `buildInviteUrl(token)` | `https://app.blissops.com/auth/invite-accept?...` | No |
| `buildResetPasswordUrl(token)` | `https://app.blissops.com/auth/password-reset-confirm?...` | No |
| `buildMagicLinkReturnUrl(path)` | `https://app.blissops.com/auth/callback?next=...` | No |

All hostnames are defined once in `CANONICAL_HOSTS` in `config.ts`.

---

## 5. Redirect Matrix

| Request | Expected Behaviour | Method |
|---|---|---|
| `http://app.blissops.com/...` | → `https://app.blissops.com/...` | Cloudflare: Always HTTPS |
| `http://admin.blissops.com/...` | → `https://admin.blissops.com/...` | Cloudflare: Always HTTPS |
| `http://blissops.com/...` | → `https://blissops.com/...` | Cloudflare: Always HTTPS |
| `https://www.blissops.com/path` | → `https://blissops.com/path` | Cloudflare: Page Rule 301 |
| `https://blissops.com/` | → `https://blissops.com/en/` | Cloudflare: 302 (until public site ships) |
| `https://app.blissops.com/app/...` | Serve SPA | No redirect |
| `https://admin.blissops.com/ops/...` | Serve SPA (Worker routes) | Cloudflare Worker |

**No redirect loop risk:**
- HTTP → HTTPS is handled exclusively at Cloudflare edge (SSL: Full Strict)
- No app-level HTTP→HTTPS redirect is emitted (app always receives HTTPS from Cloudflare)
- www → apex is Cloudflare only; app never sees www requests
- app ↔ admin ↔ root are on different subdomains — no circular routing possible

---

## 6. Security Headers — Ownership Matrix

Headers are currently set at the **Express app layer** (Phase 44). At Cloudflare edge,  
these headers are forwarded as-is in Full (Strict) mode. Cloudflare must NOT add  
duplicate/conflicting headers.

| Header | Owner | Value |
|---|---|---|
| `Strict-Transport-Security` | App (helmet) | `max-age=31536000; includeSubDomains; preload` |
| `X-Frame-Options` | App (response-security) | `DENY` |
| `X-Content-Type-Options` | App (response-security) | `nosniff` |
| `Referrer-Policy` | App (response-security) | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | App (response-security) | camera/mic/geo disabled |
| `Content-Security-Policy` | App (helmet) | See security-headers.ts |
| `X-XSS-Protection` | App (response-security) | `0` (deprecated; explicitly disabled) |

**Cloudflare edge headers (Managed Rules / Transform Rules):**
- Cloudflare may add `CF-Ray`, `CF-Cache-Status` — these are informational, not security headers
- Do NOT add HSTS via Cloudflare Transform Rules if app already sets it (duplicate causes issues)
- Cloudflare's "Security Headers" feature should be **disabled** to prevent conflicts

---

## 7. Cache Strategy

| Route Pattern | Cache Behavior | Reason |
|---|---|---|
| `/_next/static/*` or `/assets/*` | Cloudflare Cache — long TTL | Immutable static assets |
| `/api/*` | BYPASS — no caching | Dynamic, auth-sensitive, tenant-scoped |
| `/*.html` or SPA shell | BYPASS | Auth state depends on session |
| `/auth/*` | BYPASS — never cache | Sensitive callback flows |
| `/ops/*` | BYPASS — never cache | Admin ops — real-time data |
| Static files (`.js`, `.css`, fonts) | Cloudflare Cache — max-age 1 year | Versioned by Vite hash |

**Cloudflare Cache Rules to implement:**
```
Rule 1: URL path starts with /api   → Cache: BYPASS
Rule 2: URL path starts with /auth  → Cache: BYPASS
Rule 3: URL path starts with /ops   → Cache: BYPASS
Rule 4: File extension is .js, .css, .woff2, .png, .svg → Cache: Standard (1 year)
Rule 5: Default                     → Cache: BYPASS
```

---

## 8. Supabase Auth Alignment

**Production Supabase settings required:**

```
Site URL:         https://app.blissops.com
Redirect URL(s):
  https://app.blissops.com/auth/callback
  https://app.blissops.com/auth/invite-accept
  https://app.blissops.com/auth/email-verify
  https://app.blissops.com/auth/password-reset-confirm
  https://app.blissops.com/auth/mfa-challenge
```

**Must be removed from production allow-list:**
- `http://localhost:*` (dev only — keep in dev project, not prod)
- `https://*.vercel.app/*` (preview domains must not be in production allow-list)
- `https://*.replit.dev/*` (Replit preview URLs must not handle auth callbacks)

---

## 9. Cookie / Session Validation

Cookie scope defined in `client/src/lib/domain/session-scope.ts`.

| Cookie | Scope | SameSite | Secure | After Phase 52 |
|---|---|---|---|---|
| Supabase session | `app.blissops.com` | Lax | ✅ | Unchanged — correct |
| CSRF token | `app.blissops.com` | Strict | ✅ | Unchanged — correct |
| Locale pref | `.blissops.com` | Lax | ✅ | Root-domain scope — locale shared across public + app |

**Confirmed valid for new origin setup:**
- Session cookies scoped to `app.blissops.com` — unaffected by `admin.blissops.com`
- `admin.blissops.com` reads same session cookie until Phase 52+ isolation (same deployment)
- Logout clears CSRF, leaves locale — correct
- Magic link, password reset, invite — all use `buildAuthUrl()` → `app.blissops.com/auth/*`
- SameSite=Lax allows top-level navigation (e.g. clicking email links) to pass session cookie

**No CSRF risk from hybrid setup:**
- CSRF token is Strict-scoped — cannot be sent cross-site
- Admin routes on `admin.blissops.com` are same deployment — same CSRF token in memory
- When admin is isolated (Phase 52+): implement CSRF handoff or separate token per subdomain
