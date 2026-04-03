# AI Gateway — Request Flow

## Architecture

```
Client / Frontend
       │
       │  x-route-key: chat_document
       │  x-tenant-id: tenant_acme
       │  Authorization: Bearer <jwt>
       ▼
┌─────────────────────────────────┐
│   Cloudflare Worker             │
│   blissops-ai-gateway           │
│                                 │
│  1. Extract routing headers     │
│  2. KV lookup → routing rule    │
│  3. Estimate cost (stateless)   │
│  4. Budget guard check          │
│  5. Inject provider headers     │
│  6. Forward to backend          │
│  7. Fallback if needed          │
└─────────────────────────────────┘
       │
       │  x-ai-provider: google_gemini
       │  x-ai-model: gemini-2.0-flash
       │  x-ai-fallback: openai/gpt-4o-mini
       │  x-gateway-request-id: <uuid>
       │  x-gateway-secret: <secret>
       ▼
┌─────────────────────────────────┐
│   Railway Backend (Express)     │
│   blissops-production           │
│                                 │
│  Reads x-ai-model header        │
│  Uses specified provider/model  │
│  Returns x-ai-provider-error:   │
│    true  ← if provider fails    │
└─────────────────────────────────┘
       │
       ▼
     Client
```

---

## Example request flows

### Flow A — Normal (rule found, budget OK, primary succeeds)

```
1. Client → Worker
   POST /api/chat/stream
   x-route-key: chat_document
   x-tenant-id: tenant_acme
   content-length: 4200

2. Worker: KV lookup for route:tenant_acme:chat_document
   → miss (no override)
   → resolved via embedded default: gemini-2.0-flash

3. Budget guard:
   estimatedTokens = 4200 / 4 = 1050
   pricePerMillion = $0.10 (gemini-2.0-flash)
   estimatedUsd    = 1050 / 1_000_000 * 0.10 = $0.000105
   maxCostPerRequestUsd = $0.05
   → ALLOWED

4. Worker → Backend
   POST /api/chat/stream
   x-ai-provider: google_gemini
   x-ai-model:    gemini-2.0-flash
   x-ai-fallback: openai/gpt-4o-mini
   x-gateway-request-id: <uuid>
   x-gateway-secret: <secret>
   [body unchanged]

5. Backend → Worker: HTTP 200, streaming body
6. Worker → Client: HTTP 200, streaming body
   + x-gateway-request-id: <uuid>
   + x-gateway-fallback: 0
```

### Flow B — Fallback triggered (backend returns 503)

```
1–4. Same as Flow A above.

5. Backend → Worker: HTTP 503 (Gemini quota exceeded)

6. Worker detects 503 ∈ retriable statuses → fallback triggered
   Logs: fallback_triggered { primaryStatus: 503, fallbackModel: gpt-4o-mini }

7. Worker → Backend (RETRY):
   POST /api/chat/stream
   x-ai-provider:    openai
   x-ai-model:       gpt-4o-mini
   x-ai-fallback:    (empty — cleared)
   x-gateway-retry:  1
   [same body, re-streamed]

8. Backend → Worker: HTTP 200 (OpenAI succeeded)
9. Worker → Client: HTTP 200
   + x-gateway-fallback: 1   ← indicates fallback was used
```

### Flow C — Budget guard blocks request

```
1. Client → Worker
   POST /api/chat/stream
   x-route-key: chat_simple
   x-tenant-id: tenant_acme
   content-length: 2_800_000   ← 2.8MB body

2. Worker: resolved rule → gemini-2.0-flash-lite, maxCost=$0.005

3. Budget guard:
   estimatedTokens = 2_800_000 / 4 = 700_000
   pricePerMillion = $0.075
   estimatedUsd    = 700_000 / 1_000_000 * 0.075 = $0.0525
   maxCostPerRequestUsd = $0.005
   → BLOCKED (0.0525 > 0.005)

4. Worker → Client: HTTP 402
   {
     "error": "Budget limit exceeded",
     "code": "BUDGET_EXCEEDED",
     "estimatedUsd": "0.052500",
     "limitUsd": "0.005000",
     "gateway": "ai-routing"
   }
   (Backend never receives the request)
```

### Flow D — No routing rule found (pass-through)

```
1. Client → Worker
   POST /api/chat/stream
   x-route-key: unknown_route
   x-tenant-id: tenant_xyz

2. Worker: KV miss + no embedded default for route_key=unknown_route

3. Worker → Backend: request forwarded unchanged (no injected headers)
   Backend uses its own model selection logic.
```

### Flow E — Premium tenant KV override

```
# Set in KV: key=route:tenant_premium:chat_document
# Value (JSON):
{
  "tenantId": "tenant_premium",
  "routeKey": "chat_document",
  "provider": "openai",
  "model": "gpt-4o",
  "fallback": { "provider": "anthropic", "model": "claude-3-5-sonnet-20241022" },
  "budget": { "maxCostPerRequestUsd": 0.50 }
}

# Set via wrangler CLI:
npx wrangler kv key put \
  --binding AI_ROUTING \
  "route:tenant_premium:chat_document" \
  '{"tenantId":"tenant_premium","routeKey":"chat_document","provider":"openai","model":"gpt-4o","fallback":{"provider":"anthropic","model":"claude-3-5-sonnet-20241022"},"budget":{"maxCostPerRequestUsd":0.50}}'

# Worker picks up the KV override within 30s (cacheTtl: 30).
# No redeployment required.
```

---

## KV routing config — CRUD

```bash
# Read current rule for a tenant
npx wrangler kv key get --binding AI_ROUTING "route:tenant_acme:chat_document"

# Create / update rule
npx wrangler kv key put --binding AI_ROUTING \
  "route:tenant_acme:chat_document" \
  '{ "tenantId":"tenant_acme", "routeKey":"chat_document", "provider":"google_gemini", "model":"gemini-1.5-pro", "fallback":{"provider":"openai","model":"gpt-4o-mini"}, "budget":{"maxCostPerRequestUsd":0.10} }'

# Delete rule (falls back to embedded default)
npx wrangler kv key delete --binding AI_ROUTING "route:tenant_acme:chat_document"

# List all rules
npx wrangler kv key list --binding AI_ROUTING --prefix "route:"
```

---

## Backend changes required

The backend (Railway/Express) must:

1. **Read injected headers** when present and use them for provider/model selection:
   ```typescript
   const provider = req.headers["x-ai-provider"] ?? process.env.DEFAULT_AI_PROVIDER;
   const model    = req.headers["x-ai-model"]    ?? process.env.DEFAULT_AI_MODEL;
   ```

2. **Authenticate gateway requests** via `x-gateway-secret` header:
   ```typescript
   if (req.headers["x-gateway-secret"] !== process.env.GATEWAY_SECRET) {
     // Optionally reject — or just log and continue for gradual rollout
   }
   ```

3. **Signal provider errors** so the gateway can trigger fallback:
   ```typescript
   // When a provider returns 429/503/5xx:
   res.set("x-ai-provider-error", "true");
   return res.status(503).json({ error: "Provider unavailable" });
   ```

---

## Deployment

```bash
# 1. Install Wrangler
npm install -g wrangler

# 2. Authenticate
npx wrangler login

# 3. Create KV namespace
npx wrangler kv namespace create AI_ROUTING
# Copy the namespace ID into wrangler.toml

# 4. Set secrets
npx wrangler secret put GATEWAY_SECRET
# Paste the secret (must match GATEWAY_SECRET in Railway env)

# 5. Deploy
npx wrangler deploy --env production

# 6. Tail live logs
npx wrangler tail
```

---

## Stateless design — constraints and trade-offs

| Concern | Approach | Trade-off |
|---------|----------|-----------|
| Routing config | KV + embedded defaults | KV has ~30s propagation delay |
| Budget guard | Estimate from Content-Length | Underestimates if body is compressed; overestimates if Content-Length is absent (defaults to 0 bytes → never blocked) |
| Cumulative spend | Not tracked | Cannot enforce monthly/daily budget caps per tenant — must be done in backend |
| Retry | Single fallback attempt | Two backend calls on failure; no exponential backoff |
| Auth | Shared gateway secret | Secret rotation requires both sides to update |
