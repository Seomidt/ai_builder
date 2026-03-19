# Single-Domain Production Mode — blissops.com

**Status:** ACTIVE (`DOMAIN_CONFIG.mode = "single"`)
**Last updated:** March 2026

---

## 1. Current Live Production Model

| Domain | Role | Status |
|---|---|---|
| `blissops.com` | Authenticated application (tenant UI + admin UI, path-based) | **LIVE** |
| `www.blissops.com` | 301 redirect → `blissops.com` | **LIVE** |
| `app.blissops.com` | Planned: authenticated SPA subdomain | **NOT ACTIVE** |
| `admin.blissops.com` | Planned: isolated ops console | **NOT ACTIVE** |

`blissops.com` is the entire application. It is **not** a public marketing site.
All routes require authentication. Admin/ops access is path-based (`/ops/*`, `/api/admin/*`) and role-based (`platform_admin`).

---

## 2. Security Model

### Host Allowlist
Production allows only:
- `blissops.com`
- `www.blissops.com` (immediately redirected)

Blocked in production:
- `*.vercel.app`
- `*.replit.dev`, `*.replit.app`, `*.repl.co`
- `*.netlify.app`
- `localhost`, `127.0.0.1` in production

Source: `server/lib/platform/domain-config.ts` → `DOMAIN_CONFIG.allowHosts`
Enforced by: `server/middleware/host-allowlist.ts`

### Preview Host Blocking
`DOMAIN_CONFIG.blockPreviewHosts = true`. All `*.vercel.app` and Replit preview URLs return 403 in production.

### Auth-Required Root App
Every request to `/api/*` requires a valid Bearer token **except** explicit bypass paths:
- `/api/auth/config`
- `/api/admin/platform/deploy-health`
- `/api/admin/recovery/*` (CI/CD tooling)

Non-API paths (SPA routes) are served to the frontend. Client-side `ProtectedRoute` handles redirect-to-login.

Source: `server/middleware/auth.ts`

### Role-Based Admin Access
`/ops/*` and `/api/admin/*` require:
1. Valid session (`authMiddleware`)
2. Lockdown allowlist pass (`lockdownGuard`, if `LOCKDOWN_ENABLED=true`)
3. `platform_admin` role (`adminGuardMiddleware`)

**No host-based admin check.** `ADMIN_CONFIG.hostBasedAccess = false`.

Source: `server/middleware/admin-domain.ts`, `server/middleware/ai-guards.ts`

### Lockdown Compatibility
`LOCKDOWN_ENABLED=true` + `LOCKDOWN_ALLOWLIST` env vars restrict all access to specific email addresses. Compatible with single-domain mode.

---

## 3. Current Auth Model

### Auth URLs (active)
```
Login:    https://blissops.com/auth/login
Callback: https://blissops.com/auth/callback
Logout:   https://blissops.com/auth/logout
```

### Cookie Strategy
| Property | Value |
|---|---|
| Scope | `blissops.com` (exact host) |
| Secure | `true` (production only) |
| SameSite | `Lax` |
| No subdomain sharing needed | Single-domain — no cross-host handoff |

Source: `server/lib/platform/platform-hardening-config.ts` → `COOKIE_POLICY`

### Supabase OAuth Allow-List
Supabase OAuth callback must be set to:
```
https://blissops.com/auth/callback
```

---

## 4. Future Migration Plan

When activating multi-domain mode (`DOMAIN_CONFIG.mode = "multi"`):

### What changes
1. **`domain-config.ts`**: Set `mode: "multi"`, add `app.blissops.com` and `admin.blissops.com` to `allowHosts`
2. **`platform-hardening-config.ts`**: Update `PRODUCTION_ALLOWED_HOSTS`, `AUTH_CONFIG.canonicalCallbackHost`, `COOKIE_POLICY.privilegedScope`
3. **`admin-domain.ts`**: Re-enable `hostBasedAccess = true`, add redirect logic to `admin.blissops.com`
4. **`vercel.json`**: Add `app.blissops.com` and `admin.blissops.com` as Vercel project domains
5. **Supabase**: Update OAuth callback allow-list to `https://app.blissops.com/auth/callback`
6. **Cookie domain**: Change to `.blissops.com` for subdomain SSO (or keep host-only per subdomain)
7. **Cloudflare DNS**: Add CNAME records for `app` and `admin` pointing to Vercel
8. **robots.txt**: Allow: / on `blissops.com` (marketing), Disallow: / on `app.blissops.com` and `admin.blissops.com`

### What must NOT change
- Lockdown guard remains active
- Role-based admin enforcement remains (even if host-based is added)
- Preview host blocking remains
- Auth middleware bypass paths remain minimal
- `LOCKDOWN_ENABLED` env var behavior unchanged

### Migration order (recommended)
1. Provision `app.blissops.com` in Vercel + Cloudflare
2. Set up SSL + DNS validation
3. Update Supabase OAuth allow-list
4. Deploy with `DOMAIN_CONFIG.mode = "multi"`
5. Set up 301 redirects: `blissops.com/dashboard` → `app.blissops.com/dashboard`
6. Wait for DNS TTL, then proxy ON in Cloudflare
7. Repeat for `admin.blissops.com`

---

## 5. Validation

Run at any time to verify single-domain mode is correctly enforced:

```bash
npx tsx scripts/validate-single-domain.ts
```

Expected: `SINGLE DOMAIN MODE: COMPLETE ✅` — all assertions pass.
