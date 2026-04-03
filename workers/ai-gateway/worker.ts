/**
 * worker.ts — Cloudflare Worker: AI Routing Gateway
 *
 * Responsibility: ROUTE, not compute.
 * Reads x-route-key + x-tenant-id, resolves routing rule, injects
 * x-ai-provider / x-ai-model / x-ai-fallback, and proxies to backend.
 *
 * DOES NOT:
 *  - Call AI providers directly
 *  - Perform billing or OCR
 *  - Mutate the request body
 *  - Store per-tenant spend (stateless by design)
 *
 * DOES:
 *  - Inject provider/model/fallback headers before backend call
 *  - Block requests that exceed per-request cost estimate (budget guard)
 *  - Retry once with fallback model on retriable backend errors
 *  - Log decisions as structured JSON for Cloudflare logpush
 */

import {
  DEFAULT_ROUTING_RULES,
  MODEL_PRICING_PER_1M_INPUT,
  buildKvKey,
  resolveRule,
  type RoutingRule,
} from "./routing-config";

// ── Environment bindings (defined in wrangler.toml) ───────────────────────────

export interface Env {
  /** KV namespace for dynamic routing overrides. Binding name: AI_ROUTING */
  AI_ROUTING: KVNamespace;
  /** Backend URL — e.g. https://api.blissops.com (Railway) */
  BACKEND_URL: string;
  /** Secret shared between gateway and backend for internal calls */
  GATEWAY_SECRET: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER_ERROR_HEADER = "x-ai-provider-error";
const DEFAULT_RETRIABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Conservative estimate: 1 token ≈ 4 bytes of UTF-8 text */
const BYTES_PER_TOKEN = 4;

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startMs = Date.now();
    const requestId = crypto.randomUUID();

    // ── Extract routing headers ─────────────────────────────────────────────
    const routeKey  = request.headers.get("x-route-key")?.trim()  ?? "chat_document";
    const tenantId  = request.headers.get("x-tenant-id")?.trim()  ?? "unknown";

    // ── Load routing rule ───────────────────────────────────────────────────
    let rule: RoutingRule | null = null;

    // 1. Try KV override (dynamic, per-tenant, hot-reloadable without redeploy)
    try {
      const kvKey = buildKvKey(tenantId, routeKey);
      const raw   = await env.AI_ROUTING.get(kvKey, { cacheTtl: 30 });
      if (raw) {
        const parsed = JSON.parse(raw) as RoutingRule;
        rule = parsed;
        log("routing_rule_source", { requestId, tenantId, routeKey, source: "kv" });
      }
    } catch (err) {
      log("kv_load_error", { requestId, error: String(err) });
    }

    // 2. Fall back to embedded defaults
    if (!rule) {
      rule = resolveRule(DEFAULT_ROUTING_RULES, tenantId, routeKey);
      if (rule) {
        log("routing_rule_source", { requestId, tenantId, routeKey, source: "embedded_default" });
      }
    }

    // 3. No rule found: pass through with no injected headers
    if (!rule) {
      log("routing_rule_missing", { requestId, tenantId, routeKey });
      return forwardToBackend(request, env, {}, requestId);
    }

    // ── Budget guard (stateless cost estimate) ──────────────────────────────
    const costCheck = estimateCost(request, rule);
    if (costCheck.blocked) {
      log("budget_guard_blocked", {
        requestId, tenantId, routeKey,
        estimatedUsd:    costCheck.estimatedUsd,
        maxCostUsd:      rule.budget.maxCostPerRequestUsd,
        estimatedTokens: costCheck.estimatedTokens,
      });
      return budgetExceededResponse(costCheck.estimatedUsd, rule.budget.maxCostPerRequestUsd);
    }

    // ── Build injected headers ──────────────────────────────────────────────
    const injectHeaders: Record<string, string> = {
      "x-ai-provider": rule.provider,
      "x-ai-model":    rule.model,
    };
    if (rule.fallback) {
      injectHeaders["x-ai-fallback"] = `${rule.fallback.provider}/${rule.fallback.model}`;
    }

    log("routing_decision", {
      requestId, tenantId, routeKey,
      provider:   rule.provider,
      model:      rule.model,
      fallback:   rule.fallback ?? null,
      estimatedUsd: costCheck.estimatedUsd,
    });

    // ── Primary attempt ─────────────────────────────────────────────────────
    const primaryResponse = await forwardToBackend(request, env, injectHeaders, requestId);

    // ── Fallback retry ──────────────────────────────────────────────────────
    const retriable = rule.retryOnStatusCodes
      ? new Set(rule.retryOnStatusCodes)
      : DEFAULT_RETRIABLE_STATUSES;

    const isRetriable = retriable.has(primaryResponse.status)
      || primaryResponse.headers.get(PROVIDER_ERROR_HEADER) === "true";

    if (isRetriable && rule.fallback) {
      log("fallback_triggered", {
        requestId, tenantId, routeKey,
        primaryStatus: primaryResponse.status,
        fallbackProvider: rule.fallback.provider,
        fallbackModel:    rule.fallback.model,
      });

      const fallbackHeaders: Record<string, string> = {
        "x-ai-provider":    rule.fallback.provider,
        "x-ai-model":       rule.fallback.model,
        "x-ai-fallback":    "",
        "x-gateway-retry":  "1",
      };

      const fallbackResponse = await forwardToBackend(request, env, fallbackHeaders, requestId);

      log("fallback_result", {
        requestId,
        fallbackStatus: fallbackResponse.status,
        totalMs: Date.now() - startMs,
      });

      return addGatewayHeaders(fallbackResponse, requestId, true);
    }

    log("primary_result", {
      requestId,
      primaryStatus: primaryResponse.status,
      totalMs: Date.now() - startMs,
    });

    return addGatewayHeaders(primaryResponse, requestId, false);
  },
} satisfies ExportedHandler<Env>;

// ── forwardToBackend ──────────────────────────────────────────────────────────

/**
 * Clone the original request, inject additional headers, and send to backend.
 * Does NOT mutate the request body — body is streamed as-is.
 */
async function forwardToBackend(
  original:        Request,
  env:             Env,
  injectHeaders:   Record<string, string>,
  requestId:       string,
): Promise<Response> {
  const url = new URL(original.url);
  url.hostname = new URL(env.BACKEND_URL).hostname;
  url.port     = new URL(env.BACKEND_URL).port;
  url.protocol = new URL(env.BACKEND_URL).protocol;

  const outHeaders = new Headers(original.headers);

  // Inject routing headers
  for (const [key, value] of Object.entries(injectHeaders)) {
    if (value) {
      outHeaders.set(key, value);
    } else {
      outHeaders.delete(key);
    }
  }

  // Authenticate to backend as trusted gateway
  outHeaders.set("x-gateway-request-id", requestId);
  outHeaders.set("x-gateway-secret", env.GATEWAY_SECRET);

  const forwardedRequest = new Request(url.toString(), {
    method:  original.method,
    headers: outHeaders,
    body:    original.body,
    // @ts-expect-error — duplex required for streaming body in Workers
    duplex: "half",
    redirect: "follow",
  });

  try {
    return await fetch(forwardedRequest);
  } catch (err) {
    log("backend_fetch_error", { requestId, error: String(err) });
    return new Response(
      JSON.stringify({ error: "Backend unreachable", gateway: "ai-routing" }),
      {
        status:  502,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

// ── Budget guard ──────────────────────────────────────────────────────────────

interface CostEstimate {
  blocked:         boolean;
  estimatedTokens: number;
  estimatedUsd:    number;
}

/**
 * Stateless cost estimate from Content-Length (or 0 if unknown).
 * Formula: tokens = bytes / BYTES_PER_TOKEN; cost = tokens / 1e6 * price_per_1m.
 *
 * Conservative by design — underestimates are safe (we don't over-block).
 * Exact token counting requires body parsing which would break streaming.
 */
function estimateCost(request: Request, rule: RoutingRule): CostEstimate {
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  const bodyBytes     = Number.isFinite(contentLength) ? contentLength : 0;

  const estimatedTokens = Math.ceil(bodyBytes / BYTES_PER_TOKEN);
  const pricePerMillion = MODEL_PRICING_PER_1M_INPUT[rule.model] ?? 1.00;
  const estimatedUsd    = (estimatedTokens / 1_000_000) * pricePerMillion;
  const blocked         = estimatedUsd > rule.budget.maxCostPerRequestUsd;

  return { blocked, estimatedTokens, estimatedUsd };
}

// ── Response helpers ──────────────────────────────────────────────────────────

function budgetExceededResponse(estimatedUsd: number, limitUsd: number): Response {
  return new Response(
    JSON.stringify({
      error:        "Budget limit exceeded",
      code:         "BUDGET_EXCEEDED",
      estimatedUsd: estimatedUsd.toFixed(6),
      limitUsd:     limitUsd.toFixed(6),
      gateway:      "ai-routing",
    }),
    {
      status:  402,
      headers: { "content-type": "application/json" },
    },
  );
}

function addGatewayHeaders(response: Response, requestId: string, wasFallback: boolean): Response {
  const mutable = new Response(response.body, response);
  mutable.headers.set("x-gateway-request-id", requestId);
  mutable.headers.set("x-gateway-fallback", wasFallback ? "1" : "0");
  return mutable;
}

// ── Structured logging ────────────────────────────────────────────────────────

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({
    ts:      new Date().toISOString(),
    svc:     "ai-gateway",
    event,
    ...fields,
  }));
}
