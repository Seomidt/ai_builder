# AI Ops Assistant — Architecture

**Phase**: 51  
**Platform**: blissops.com — AI Builder Platform  
**Status**: COMPLETE ✅  
**Date**: 2026-03-19  

---

## 1. Supported Intents

The assistant operates on a **closed set of 10 intents**. Free-form prompting is not supported.

| Intent ID | Display Name | Scope |
|---|---|---|
| `platform_health_summary` | Platform Health Summary | platform |
| `tenant_usage_summary` | Tenant Usage Summary | tenant |
| `ai_cost_summary` | AI Cost Summary | platform/tenant |
| `anomaly_explanation` | Anomaly Explanation | platform/tenant |
| `billing_health_summary` | Billing Health Summary | platform |
| `retention_summary` | Retention Summary | platform |
| `support_debug_summary` | Support Debug Summary | tenant |
| `security_summary` | Security Summary | platform |
| `storage_health_summary` | Storage Health Summary | platform/tenant |
| `weekly_ops_digest` | Weekly Ops Digest | platform |

---

## 2. Allowed Data Sources

The assistant may ONLY access these 13 sources:

| Source ID | Type | Admin Only |
|---|---|---|
| `analytics_daily_rollups` | Aggregated | No |
| `tenant_ai_budgets` | Per-tenant | No |
| `tenant_ai_usage_snapshots` | Per-tenant aggregate | No |
| `ai_usage_alerts` | Per-tenant | No |
| `gov_anomaly_events` | Per-tenant | Yes |
| `security_events_aggregated` | Platform aggregate | Yes |
| `stripe_subscriptions_summary` | Platform aggregate | Yes |
| `stripe_invoices_summary` | Platform aggregate | Yes |
| `obs_system_metrics` | Platform aggregate | Yes |
| `obs_tenant_usage_metrics` | Per-tenant aggregate | No |
| `obs_ai_latency_metrics` | Platform aggregate | Yes |
| `storage_summary` | Per-tenant aggregate | No |
| `platform_health_synthetic` | Synthetic | Yes |

### Forbidden Source Categories

- `raw_ai_prompts`
- `raw_ai_outputs`
- `private_documents`
- `raw_checkin_text`
- `arbitrary_tenant_content`
- `user_pii`
- `signed_urls`
- `api_keys`
- `secrets`
- `webhook_payloads_raw`

---

## 3. Access Model

| Role | Platform-wide | Tenant-scoped |
|---|---|---|
| `platform_admin` | ✅ Full access | ✅ Any tenant |
| `tenant_admin` | ❌ Denied | ✅ Own org only |
| Regular user | ❌ Denied | ❌ Denied |

Implementation: `server/lib/ai-ops/access-control.ts`

---

## 4. Scope Model

Two scope modes:

- **Platform scope**: Aggregated across all tenants. Platform admins only.
- **Tenant scope**: Isolated to a single `organization_id`. Enforced at context assembly.

Cross-tenant access in tenant mode is impossible by design — `assertTenantScopeAllowed()` throws if mismatched.

---

## 5. Output Contracts

Every intent has a strict Zod-validated output contract defined in `response-contracts.ts`.

All responses include:

```typescript
{
  intent: string;
  scope: "platform" | "tenant";
  organizationId: string | null;
  summary: string;          // max 600 chars
  findings: Finding[];      // max 6
  risks: Risk[];            // max 4
  recommendedActions: RecommendedAction[];  // max 4
  confidence: "high" | "medium" | "low" | "insufficient_data";
  dataFreshness: string;
  sourcesUsed: string[];
  generatedAt: string;
}
```

---

## 6. Privacy Boundaries

- `actor_user_id`, `client_id`, `session_id`, `idempotency_key` are **never** included in context
- `ip_address`, `user_agent` are **never** included
- All Stripe IDs and URLs are **never** included
- Secrets, tokens, signed URLs are **never** included
- `redactUnsafeOpsContext()` strips any accidentally included fields before AI call

---

## 7. Anti-Hallucination / Grounding Model

1. Context is assembled from structured DB queries — not free-form retrieval
2. System prompt explicitly instructs model to **only** reference what is in context
3. If data is unavailable, model must set `confidence: "insufficient_data"` 
4. Output is validated against Zod contract — invalid outputs are rejected
5. `assertAiOpsOutputSafe()` rejects outputs containing action-implying language

---

## 8. Why Rollups Instead of Raw Events

`analytics_daily_rollups` is used instead of `analytics_events` because:

- **Privacy**: Raw events may contain `actor_user_id`, `session_id`, `client_id`
- **Performance**: Rollups are pre-aggregated — fast at query time
- **Safety**: Rollup rows contain no PII, only counts and family/name labels
- **Freshness**: Rollups are computed daily; freshness is displayed to operators

---

## 9. Future Extension Path

- Add new intents by extending `INTENT_DEFINITIONS` in `intents.ts`
- Add new sources by extending `AI_OPS_DATA_SOURCES` in `data-sources.ts`
- New context assemblers go in `context-assembler.ts`
- New response contracts go in `response-contracts.ts`
- Validation script `scripts/validate-phase51.ts` must be updated for new intents

---

## Files

```
server/lib/ai-ops/
  data-sources.ts        — allowed source registry
  intents.ts             — supported intent definitions
  access-control.ts      — assertAiOpsAccess, resolveAiOpsScope
  context-assembler.ts   — buildPlatformHealthContext, etc.
  response-contracts.ts  — Zod output schemas per intent
  orchestrator.ts        — main query pipeline
  safety.ts              — assertAiOpsSafeContext, redactUnsafeOpsContext
  digest.ts              — weekly digest with caching
  audit.ts               — safe usage audit logging

server/routes/admin.ts   — AI Ops API routes
client/src/pages/ops/assistant.tsx  — Admin UI

docs/security/ai-ops-safety.md     — safety documentation
scripts/validate-phase51.ts        — 70+ scenarios, 300+ assertions
```
