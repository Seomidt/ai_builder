# Analytics vs Audit vs Security — Separation Guide

**Platform**: blissops.com — AI Builder Platform  
**Phase**: 50 — Analytics Foundation  
**Last updated**: 2026-03-19

---

## 1. Three Separate Concerns

| Store | Purpose | Owner | Retention | Access |
|---|---|---|---|---|
| `analytics_events` | Behavioral / product metrics | analytics layer | 90 days (rolling) | service_role only → aggregated admin read |
| `security_events` | Security/system incidents | security layer | 1 year minimum | security team / ops dashboard |
| Audit logs (structured) | Compliance / action trace | compliance layer | Legal hold aware | legal / compliance / service_role |

**These must never be merged or confused.**

---

## 2. analytics_events — Behavioral / Product Metrics

**Purpose**: Understanding how users and organizations use the product.

**Contains**:
- Event names from canonical taxonomy (product.*, funnel.*, retention.*, billing.*, ai.*, ops.*)
- Organization / actor IDs (for tenant scoping — not PII profiles)
- Counts, durations, flags, feature names, locale, domain role
- Session / request IDs for correlation
- Sanitized, redacted property bags

**Does NOT contain**:
- Raw user content (prompts, notes, checkin text)
- Security incidents
- Compliance-sensitive action traces
- Passwords, tokens, secrets
- Full payment details

**Consumption**:
- Daily rollups in `analytics_daily_rollups`
- Admin/ops aggregated endpoints (`/api/admin/analytics/*`)
- Phase 51 AI Ops Assistant context

**Examples** (goes in analytics_events):
```
product.login            — user logged in (org + actor id, locale, timestamp)
funnel.pricing_view      — pricing page viewed (locale, referrer route)
billing.checkout_started — checkout flow initiated (plan_tier, org_id)
ai.request_completed     — AI request finished (org_id, duration_ms, status)
ops.dashboard_viewed     — admin viewed ops dashboard (actor_id, timestamp)
```

---

## 3. security_events — Security / System Incidents

**Purpose**: Detecting, alerting, and auditing security-relevant events.

**Implemented in**: `server/lib/security/security-events.ts`

**Contains**:
- Auth failures
- Rate limit violations
- CSP violations
- RLS violations
- Suspicious activity flags
- MFA challenges
- Session expirations
- Password reset events

**Does NOT contain**:
- Product usage metrics
- Billing events
- User behavior patterns
- Analytics rollups

**Consumption**:
- Security alerting pipeline
- Ops security dashboard
- SIEM / incident response
- Anomaly detection pipeline

**Examples** (goes in security_events, NOT analytics):
```
auth_failure         — failed login attempt (IP, user agent, error type)
rate_limit_exceeded  — client exceeded rate limit (IP, route, window)
csp_violation        — CSP header violation report (blocked URI, directive)
rls_violation        — unauthorized RLS row access attempt
suspicious_activity  — anomalous request pattern detected
```

---

## 4. Audit Logs — Compliance / Action Trace

**Purpose**: Immutable, legally-defensible record of who did what and when.

**Characteristics**:
- Append-only (rows are NEVER updated or deleted within retention window)
- Subject to legal holds (`legal_holds` table)
- Tenant deletion does NOT remove audit rows if under legal hold
- Structured for compliance queries (GDPR, SOC2, etc.)

**Contains**:
- Actor who performed action
- Action type (exact operation)
- Resource affected (table, row ID)
- Before/after state (if needed)
- Timestamp and request context

**Does NOT contain**:
- Raw sensitive content
- Security incidents (those go to security_events)
- Product usage metrics

**Examples** (goes in audit logs, NOT analytics):
```
organization.member_added     — admin added user X to org Y
organization.member_removed   — admin removed user X from org Y
billing.plan_upgraded         — org upgraded from plan A to plan B (actor: admin)
ai.content_policy_override    — ops overrode content policy for org (actor, reason)
data.export_initiated         — data export requested for compliance
```

---

## 5. Decision Guide — Where Does This Event Go?

| Scenario | Goes In |
|---|---|
| User clicked "Create Program" button | analytics_events (`product.program_created`) |
| Invalid login attempt detected | security_events (`auth_failure`) |
| Admin added a member to organization | audit log |
| AI request completed (duration + status) | analytics_events (`ai.request_completed`) |
| CSP header violation received | security_events (`csp_violation`) |
| User's subscription plan changed | analytics_events (`billing.plan_changed`) + audit log |
| Pricing page was viewed | analytics_events (`funnel.pricing_view`) |
| RLS policy blocked unauthorized access | security_events (`rls_violation`) |
| Legal hold placed on tenant data | audit log |
| AI budget threshold exceeded | analytics_events (`ai.budget_exceeded`) + security_events if critical |
| User session expired | security_events (`session_expired`) |
| Daily active user counted | analytics_events (`retention.daily_active`) |

---

## 6. Anti-Patterns to Avoid

**Never**:
- Write raw prompt content to analytics_events (privacy violation)
- Write security incidents to analytics_events (wrong context)
- Mix compliance audit traces with product metrics
- Query analytics_events directly from client (PostgREST blocked by RLS)
- Use analytics rollups for security alerting (wrong latency / granularity)
- Write tokens, secrets, or PII-adjacent data to any of these stores

**Always**:
- Use `sanitizeAnalyticsPayload()` before writing to analytics_events
- Use `isValidEventName()` to validate event names before insertion
- Keep analytics aggregated at admin layer — no raw dumps to client
- Treat each store as independent — no foreign keys across these three systems

---

## 7. Integration with Phase 51 — AI Ops Assistant

The AI Ops Assistant (Phase 51) will consume:

- `analytics_daily_rollups` — for product/usage trends
- `analyticsDailyRollups` aggregated admin endpoints — for funnel/retention analysis
- `security_events` — for security posture analysis (read-only, aggregated)
- Billing governance tables — for cost/budget analysis

The AI Ops Assistant must NOT:
- Read raw `analytics_events` rows (too noisy, privacy risk)
- Read raw `security_events` rows without aggregation
- Access audit logs (compliance boundary)
- Expose individual user or tenant data in assistant output
