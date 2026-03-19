# Phase CF-Enterprise — Cloudflare Edge Hardening

## Environment Variables Required

```
CF_API_TOKEN=<your Cloudflare API token with Zone:Edit permissions>
CLOUDFLARE_ZONE_ID=<your zone ID from Cloudflare dashboard → Overview → Zone ID>
```

`CF_API_TOKEN` is already configured as a Replit secret.
`CLOUDFLARE_ZONE_ID` must be added as a new secret.

These are **server-side only** — never exposed to the client.

---

## Files Created

| File | Purpose |
|------|---------|
| `server/lib/cloudflare/client.ts` | Typed Cloudflare API client with retry logic |
| `server/lib/cloudflare/setup-ssl.ts` | SSL strict + always-HTTPS + HSTS |
| `server/lib/cloudflare/verify-dns.ts` | Ensure all A/CNAME records are proxied |
| `server/lib/cloudflare/setup-waf.ts` | Managed WAF + 3 custom rules |
| `server/lib/cloudflare/setup-rate-limits.ts` | Edge rate limits (auth/ai/global) |
| `server/lib/cloudflare/setup-cache.ts` | Static cache (1 month) + API bypass |
| `server/lib/cloudflare/validate-cloudflare.ts` | Full validation returning structured report |
| `server/lib/cloudflare/setup-all.ts` | Orchestrator: runs all steps in order |
| `scripts/setup-cloudflare.ts` | CLI: `npx tsx scripts/setup-cloudflare.ts` |
| `scripts/validate-cloudflare.ts` | CI validation: `npx tsx scripts/validate-cloudflare.ts` |

---

## Rules Applied

### SSL & Transport
- SSL mode: `strict`
- Always HTTPS: `on`
- HSTS: `max_age=15552000`, `include_subdomains`, no preload
- Min TLS: 1.2, TLS 1.3 ZRT

### WAF Custom Rules
1. `AUTH PROTECTION` — `/api/auth` → `managed_challenge`
2. `AI PROTECTION` — `/api/ai` → `managed_challenge`
3. `GEO FILTER` — non-DK/US/DE → `managed_challenge`

### Edge Rate Limits
| Path | Threshold | Action |
|------|-----------|--------|
| `/api/auth/*` | 10 req/60s | block |
| `/api/ai/*` | 20 req/60s | block |
| `/api/*` | 100 req/60s | managed_challenge |

### Cache Rules
| Condition | Action |
|-----------|--------|
| Static extensions (js/css/png/svg/…) | cache_everything, 30-day edge TTL |
| `/api/*` | bypass cache |

---

## CLI Usage

```bash
# Full setup (run once per environment)
npx tsx scripts/setup-cloudflare.ts

# Validation only (use in CI)
npx tsx scripts/validate-cloudflare.ts
```

Exit code `0` = all checks passed. Exit code `1` = failures or fatal errors.

---

## CSP Report Integration (Task 8)

Already implemented in Phase 44:
- `POST /api/security/csp-report` — receives browser violation reports
- `Reporting-Endpoints` header points to `/api/security/csp-report`
- Violations stored in `security_events` table with type `csp_violation`
- No additional Cloudflare config needed — Cloudflare passes `POST` requests through to origin

---

## Validation Report Structure

```json
{
  "ssl": true,
  "https": true,
  "hsts": true,
  "dns": true,
  "waf": true,
  "rateLimits": true,
  "cache": true,
  "allPassed": true,
  "details": { ... }
}
```

---

## Plan Availability Notes

| Feature | Free | Pro | Business |
|---------|------|-----|----------|
| SSL strict | ✔ | ✔ | ✔ |
| Always HTTPS | ✔ | ✔ | ✔ |
| HSTS | ✔ | ✔ | ✔ |
| Custom firewall rules | 5 rules | 20 rules | 100 rules |
| Managed WAF (OWASP) | ✗ | ✔ | ✔ |
| Edge rate limiting | ✗ | ✔ | ✔ |
| Cache rules | ✗ | ✔ | ✔ |

Setup scripts degrade gracefully on free plans — critical SSL/HTTPS/HSTS always applied.
