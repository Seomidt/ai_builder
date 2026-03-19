# AI Ops Assistant — Safety Documentation

**Phase**: 51  
**Platform**: blissops.com  
**Status**: PRODUCTION SAFE ✅  

---

## 1. Privacy Guarantees

### What is NEVER included in assistant context

| Category | Examples |
|---|---|
| User identity | `actor_user_id`, `client_id`, `session_id` |
| Network data | `ip_address`, `user_agent` |
| Payment data | `stripe_customer_id`, `stripe_subscription_id`, `hosted_invoice_url` |
| Secrets | `api_key`, `token`, `private_key`, `password` |
| Storage paths | `r2_key`, `signed_url`, `file_path` |
| Raw content | Prompts, AI outputs, document text, check-in text |
| Idempotency | `idempotency_key` |

All context passes through `redactUnsafeOpsContext()` before the AI call. Any accidental field inclusion is stripped to `"[REDACTED]"`.

---

## 2. Scope Enforcement

### Platform scope
- Only `platform_admin` role may request platform-wide intents
- Tenant-specific intents are always scoped by `organization_id`
- No cross-tenant data is ever aggregated in tenant scope

### Tenant scope
- `assertTenantScopeAllowed()` compares requested org vs scope org
- Mismatch → `AiOpsTenantScopeError` (403)
- Tenant admins cannot escalate to platform scope

---

## 3. Forbidden Source Categories

These categories are explicitly forbidden from inclusion in context:

```
raw_ai_prompts
raw_ai_outputs
private_documents
raw_checkin_text
arbitrary_tenant_content
user_pii
signed_urls
api_keys
secrets
webhook_payloads_raw
```

Violations are detected by `assertAiOpsSafeContext()` and throw `AiOpsSafetyError`.

---

## 4. Logging Model

### What IS logged (safe)

| Field | Description |
|---|---|
| `auditId` | Random per-request ID |
| `userId` | User who requested |
| `intent` | Intent name |
| `scope` | "platform" or "tenant" |
| `organizationId` | Org being queried (if tenant scope) |
| `success` | Boolean |
| `errorMessage` | Truncated to 200 chars |
| `timestamp` | ISO timestamp |

### What is NEVER logged

- Assembled context
- AI-generated output
- API keys or tokens
- Raw DB query results
- User PII

Audit entries are stored in-memory (max 500) and logged as structured JSON with `[AI-OPS-AUDIT]` prefix.

---

## 5. Output Safety

`assertAiOpsOutputSafe()` rejects outputs containing:

- "will now delete/remove/execute/run/create/update"
- "I have deleted/removed/created/updated/executed"
- "action taken"
- "I am confident that"
- "definitely is/are/will/has"
- "guaranteed to"

The assistant is **advisory only**. It does not execute, modify, or take actions.

---

## 6. Anti-Hallucination Controls

1. **Bounded context**: Model only receives structured JSON from allowed sources
2. **Grounding instruction**: System prompt requires model to only reference provided context
3. **Insufficient data signal**: Model must set `confidence: "insufficient_data"` when data is sparse
4. **Contract validation**: Zod schema rejects responses with missing or invalid fields
5. **Temperature = 0.1**: Low temperature reduces creative/fabricated outputs

---

## 7. Rollup Preference Policy

The assistant **prefers** `analytics_daily_rollups` over `analytics_events` because:

- Raw events contain `actor_user_id`, `session_id`, `client_id` — all forbidden
- Rollups are pre-aggregated counts with no PII
- Rollup queries are faster and safer for the AI context window

---

## 8. Intent Restriction Policy

Only 10 intents are supported. Any request for an unsupported intent:

1. Triggers `assertNoForbiddenIntent()` → `AiOpsSafetyError`
2. Is logged as a failed audit event
3. Returns HTTP 400 with a list of supported intents

---

## AI OPS ASSISTANT: FULLY READY ✅
