# Phase CF-Pro-Optimization — Cloudflare Pro Edge Security

## Quick Reference

```bash
# Full setup (run once per env, idempotent)
npx tsx scripts/setup-cloudflare.ts

# Validation only (use in CI)
npx tsx scripts/validate-cloudflare.ts
```

Exit code `0` = all critical checks pass. Exit code `1` = critical failure.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_GLOBAL_API_KEY` | 37-char Global API Key (Profile → API Tokens → Global API Key) |
| `CLOUDFLARE_EMAIL` | Cloudflare account login email |
| `CLOUDFLARE_ZONE_ID` | Zone ID from dashboard → Overview → Zone ID |

All variables are **server-only** — never exposed to the client.

---

## Cloudflare Pro Assumptions

- Plan: **Pro** (required for managed rules, edge rate limiting, cache rules)
- Zone: `blissops.com`
- Rate limit slots: **2 per zone** on Pro plan
- `matches` operator in cache rules: requires Business/WAF Advanced — we use `contains` instead

---

## What is Configured

### 1. SSL & Transport

| Setting | Value |
|---------|-------|
| SSL mode | `strict` |
| Always HTTPS | `on` |
| HSTS | `max_age=15552000`, `include_subdomains=true` |
| Min TLS | 1.2 |
| TLS 1.3 | ZRT (0-RTT) |

### 2. Managed WAF Rules

Both enabled via the `http_request_firewall_managed` phase:

| Ruleset | ID |
|---------|-----|
| Cloudflare Managed Ruleset | `efb7b8c949ac4650a09736fc376e9aee` |
| Cloudflare OWASP Core Ruleset | `4814384a9e5d4991b9815dcfc25d2f1f` |

Managed rules provide broad OWASP Top 10 + Cloudflare threat intel coverage. They complement (not replace) the custom rules below.

### 3. Custom WAF Rules

Kept because managed rules do NOT target these specific application paths:

| Rule | Expression | Action | Why kept |
|------|-----------|--------|---------|
| AUTH PROTECTION | `/api/auth` contains | managed_challenge | Explicit auth protection beyond OWASP |
| AI PROTECTION | `/api/ai` contains | managed_challenge | Expensive endpoint, explicit challenge |
| GEO FILTER | non-DK/US/DE | managed_challenge | Business model constraint |

### 4. Edge Rate Limiting (2 Pro plan slots)

Only **AUTH** and **AI** use the 2 available Pro slots. These are the highest-value endpoints to rate-limit at edge:

| Rule | Path | Threshold | Action |
|------|------|-----------|--------|
| AUTH | `/api/auth` | 10 req/60s | block |
| AI | `/api/ai` | 20 req/60s | block |

**Global `/api/*` rate limiting** is handled at the app layer (Phase 44 server-side rate limiting — `server/lib/security/api-rate-limits.ts`). This is intentional: the edge slot is too valuable for broad coverage.

### 5. Skip Rules (WAF Exceptions)

Only **2 paths** are exempted from WAF challenge. Both are machine-to-machine endpoints where a challenge cannot be completed:

| Path | Method | Reason |
|------|--------|--------|
| `/api/security/csp-report` | POST | Browsers send CSP reports automatically — no user interaction to complete challenge |
| `/api/admin/stripe/webhook` | POST | Stripe sends signed webhook events — cannot complete challenge, would break billing |

Skip rules are placed **first** in the custom ruleset so they execute before challenge rules.

No sensitive admin routes are exempted. No broad path prefixes are skipped.

### 6. Cache Rules

| Rule | Condition | Action |
|------|-----------|--------|
| STATIC ASSETS | Extension: js/css/png/svg/woff/… | Edge TTL 30 days, browser TTL 1 day |
| API BYPASS | Path contains `/api/` | No cache |

### 7. DNS

Both `blissops.com` and `www.blissops.com` A-records are proxied (orange-cloud). Setup script auto-corrects if proxy is disabled.

---

## Defense-in-Depth Architecture

```
Internet
    │
    ▼
Cloudflare Edge
  ├── SSL strict + HSTS (transport)
  ├── DNS proxied (hides origin IP)
  ├── Managed Rules: Cloudflare + OWASP (broad threat coverage)
  ├── Custom WAF: auth/ai/geo challenge (path-specific)
  ├── Edge Rate Limits: AUTH 10/min + AI 20/min (highest-value slots)
  ├── Skip: CSP reports + Stripe webhooks (machine POSTs)
  └── Cache: static 30d, /api/* bypass
    │
    ▼
App Layer (Express)
  ├── Phase 44 rate limiting: all /api/* routes
  ├── AI abuse guard: input cap, burst control, injection detection
  ├── HSTS headers (server-side redundancy)
  └── CSP + security headers
    │
    ▼
Supabase (Postgres + Auth)
  └── RLS policies on all tables
```

---

## Recovery from Drift

If Cloudflare config drifts (manual dashboard changes, plan changes), re-run:

```bash
npx tsx scripts/setup-cloudflare.ts
```

All operations are idempotent:
- Rules only updated if expression/action changed
- SSL settings always re-applied
- Managed rules only added if not already deployed
- Skip rules placed first, never duplicated

To verify without changing anything:

```bash
npx tsx scripts/validate-cloudflare.ts
```

---

## Plan Upgrade Notes

| Feature | Free | Pro | Business |
|---------|------|-----|----------|
| SSL/HTTPS/HSTS | ✔ | ✔ | ✔ |
| Custom WAF rules | 5 | 20 | 100 |
| Managed rules | ✗ | ✔ | ✔ |
| OWASP Core | ✗ | ✔ | ✔ |
| Edge rate limits | ✗ | 2 | 5 |
| Cache rules | ✗ | ✔ | ✔ |
| `matches` in cache | ✗ | ✗ | ✔ |

If upgrading to Business: increase `RATE_LIMIT_RULES` in `setup-rate-limits.ts` to 5 and add global `/api/*` edge rule.
