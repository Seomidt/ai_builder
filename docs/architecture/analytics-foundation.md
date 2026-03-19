# Analytics Foundation

**Platform**: blissops.com — AI Builder Platform  
**Phase**: 50 — Analytics Foundation  
**Last updated**: 2026-03-19  
**Status**: IMPLEMENTATION COMPLETE — DB migration pending

---

## 1. Event Taxonomy

Canonical events are defined in `server/lib/analytics/event-taxonomy.ts`.

**Six families:**

| Family | Purpose | Example events |
|---|---|---|
| `product` | Core product interactions | login, program_created, checkin_submitted |
| `funnel` | Acquisition + conversion | landing_view, pricing_view, signup_completed |
| `retention` | Engagement + stickiness | session_started, session_weekly_active, daily_active |
| `billing` | Revenue flows | checkout_started, invoice_paid, plan_changed |
| `ai` | AI usage + limits | request_started, request_completed, budget_exceeded |
| `ops` | Admin/ops interactions | dashboard_viewed, alert_opened, anomaly_viewed |

**Total canonical events**: 38 defined, versioned, stable.

**Rules:**
- Event names are `family.action_noun` — never free-form strings
- All events validated against taxonomy before insertion
- Unknown event names are dropped with a warning — never silently accepted

---

## 2. Payload Privacy Rules

Implemented in `server/lib/analytics/privacy-rules.ts`.

**Three enforcement functions:**

| Function | Behaviour |
|---|---|
| `sanitizeAnalyticsPayload(payload)` | Removes forbidden keys — returns clean payload |
| `assertAnalyticsPayloadAllowed(payload)` | Throws if forbidden keys present — use in tests |
| `redactAnalyticsPayload(payload)` | Replaces forbidden values with `[REDACTED]` — for audit traces |

**Forbidden keys include (full list in privacy-rules.ts):**
`prompt`, `raw_response`, `checkin_text`, `password`, `token`, `api_key`, `card_number`,  
`signed_url`, `file_content`, `private_doc`, and any key matching patterns: `*secret*`,  
`*password*`, `*token*`, `*private*`, `raw_*`, `*_raw`, `*credential*`

**Allowed in analytics payloads:**
- IDs (organization_id, actor_user_id — at row level, not in properties)
- plan_tier, feature, route, locale, domain_role
- Counts, durations (ms), status values, flags
- Device/session metadata if safe

---

## 3. Tenant-Safety Model

| Property | Implementation |
|---|---|
| Tenant scoping | `organization_id` on every event where tenant context exists |
| No cross-tenant reads | RLS enabled on both tables — service_role_only |
| Admin reads | Aggregated only via `/api/admin/analytics/*` — no raw row access from client |
| Payload isolation | Each event's `properties` only contains sanitized, non-identifying metadata |
| No PII in properties | User identifiers at row level (`actor_user_id`) — not in JSON properties |

**Organization context is derived server-side from auth session** — client-provided org ID is never trusted blindly. The server reads `req.user.organizationId` from the verified session.

---

## 4. Client vs Server Ingestion

### Server-side (preferred for business-critical events)

File: `server/lib/analytics/track-event.ts`

```typescript
await trackAnalyticsEvent({ eventName: "product.login", source: "server", organizationId, actorUserId });
await trackProductEvent("product.program_created", { organizationId, actorUserId });
await trackBillingEvent("billing.checkout_completed", { organizationId });
await trackAiEvent("ai.request_completed", { organizationId, properties: { duration_ms: 450, status: "ok" } });
```

**Characteristics:**
- Runs in authenticated Express route context
- Always has correct organizationId from session
- Never blocks request path (try/catch, failure = warn + continue)
- Validates event name + sanitizes payload

### Client-side (for UI/UX flows, public funnel)

File: `client/src/lib/analytics/track.ts`
Hook: `client/src/hooks/use-track-event.ts`

```typescript
import { trackFunnel, trackProduct } from "@/lib/analytics/track";
trackFunnel("funnel.pricing_view");
trackProduct("product.dashboard_viewed", { properties: { route: "/app/dashboard" } });

const trackEvent = useTrackEvent();
trackEvent({ eventName: "product.program_created" });
```

**Client → Server pipeline:**
```
Client track() → POST /api/analytics/track → server validates + sanitizes → DB insert
```

**Client never:**
- Bypasses validation (event names validated on both sides)
- Sends forbidden payload fields (sanitized client-side first, then server-side)
- Trusts client-provided org context (server derives from session)

---

## 5. Rollup Model

File: `server/lib/analytics/rollups.ts`  
Script: `scripts/run-analytics-rollups.ts`

**Pipeline:**
```
analytics_events (raw) → aggregateDailyAnalyticsRollups(date) → analytics_daily_rollups
```

**Rollup functions:**
- `aggregateDailyAnalyticsRollups(date)` — main entry point, upserts all rollups for a given date
- `countDailyEvents(date)` — counts events per name/family for the date
- `computeUniqueUsers(eventName, date)` — counts distinct actor_user_ids
- `summarizeProperties(eventName, date)` — produces frequency map of property values

**Schema:**
```
analytics_daily_rollups
  date, event_family, event_name → unique constraint
  event_count (bigint), unique_users (bigint), properties_summary (jsonb)
```

**Running the rollup:**
```bash
npx tsx scripts/run-analytics-rollups.ts              # yesterday
npx tsx scripts/run-analytics-rollups.ts 2026-03-01   # specific date
```

**Phase 51 note**: Daily rollups are the primary feed for AI Ops Assistant analysis.  
Do not feed raw events to the AI — only rollups and aggregated admin endpoints.

---

## 6. Event Ownership Guidelines

| Who instruments | What they instrument |
|---|---|
| Auth routes | product.login, product.logout, product.signup_completed |
| Program routes | product.program_created, product.program_assigned |
| Checkin routes | product.checkin_submitted, retention.checkin_completed |
| Billing routes | billing.checkout_started/completed, billing.invoice_paid, billing.payment_failed |
| AI routes | ai.request_started/completed/failed, ai.limit_warning_shown, ai.budget_exceeded |
| Ops routes | ops.dashboard_viewed, ops.alert_opened, ops.anomaly_viewed |
| Public pages (client) | funnel.landing_view, funnel.pricing_view, funnel.signup_view, funnel.signup_completed |
| Client SPA | product.dashboard_viewed, retention.session_started, retention.daily_active |

**Rule**: Server routes own server events. Client owns public/UI events.  
**Rule**: Billing and AI events must be server-side — too critical to trust client.

---

## 7. How Phase 51 AI Ops Assistant Consumes This

The Phase 51 AI Ops Assistant will have access to:

| Data source | How it's accessed | What it tells the assistant |
|---|---|---|
| `analytics_daily_rollups` | Server query, aggregated | Product usage trends, DAU/WAU, funnel conversion |
| `/api/admin/analytics/funnels` | Admin endpoint | Funnel drop-off analysis |
| `/api/admin/analytics/retention` | Admin endpoint | 30-day retention signals |
| `/api/admin/analytics/summary` | Admin endpoint | Cross-family overview |
| Billing governance tables | Existing governance layer | Cost per tenant, budget vs. actual |
| `security_events` (aggregated) | Existing security layer | Security posture signals |

**The assistant does NOT read raw analytics_events rows.**  
It operates only on aggregated, sanitized, non-identifying summaries.

---

## 8. Tables Created

| Table | Purpose | RLS |
|---|---|---|
| `analytics_events` | Raw event stream | Enabled — service_role_only |
| `analytics_daily_rollups` | Pre-aggregated daily summaries | Enabled — service_role_only |

**Indexes on analytics_events:**
- `(organization_id, occurred_at DESC)`
- `(event_family, occurred_at DESC)`
- `(event_name, occurred_at DESC)`
- `(organization_id, event_name, occurred_at DESC)`

**Indexes on analytics_daily_rollups:**
- `(date, event_family, event_name)` — unique (where org IS NULL)
- `(organization_id, date, event_name)`

---

## 9. Separation from Audit and Security

See `docs/architecture/analytics-vs-audit-vs-security.md` for full guide.

Quick summary:
- `analytics_events` = "what are users doing?" (product/behavioral)
- `security_events` = "is something suspicious happening?" (security/incidents)
- Audit logs = "who did what, when, for compliance?" (compliance/legal)

These are never merged. No foreign keys across these systems.
