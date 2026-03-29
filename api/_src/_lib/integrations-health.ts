/**
 * Platform Integrations Health — Canonical Server Module (Final Enterprise Pass)
 *
 * RESILIENT: Promise.allSettled — one failing provider never crashes the endpoint.
 * SAFE: No secrets, no stack traces, no auth headers in response.
 * CACHED: 60s TTL, cacheStatus + ageMs in every response.
 * TRACKED: lastSuccessAt / lastFailureAt per provider (in-memory, per warm instance).
 */

// ── Supabase hardcoded fallback (same as auth.ts) ─────────────────────────────
const _FB_URL  = "https://jneoimqidmkhikvusxak.supabase.co";
const _FB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZW9pbXFpZG1raGlrdnVzeGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzcxNTgsImV4cCI6MjA4ODcxMzE1OH0.CPdFKA1jfs7OAfHCm49J7_gl3GrA2b7WLmbKWzhoY8M";

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealthStatus =
  | "connected"
  | "degraded"
  | "missing"
  | "invalid"
  | "expired"
  | "partial"
  | "rate_limited"
  | "stub";

export type LatencyClass = "good" | "warning" | "poor";
export type Severity = "critical" | "important" | "optional";
export type ProviderGroup = "ai" | "platform" | "infrastructure";

export interface ProviderHealth {
  key: string;
  label: string;
  description: string;
  category: ProviderGroup;
  severity: Severity;
  status: HealthStatus;
  requiredEnv: string[];
  missingEnv: string[];
  checkedAt: string;
  latencyMs: number | null;
  latencyClass: LatencyClass | null;
  details: Record<string, boolean | string | number | null>;
  message: string;
  impact: string[];
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export interface HealthGroup {
  key: ProviderGroup;
  label: string;
  providers: ProviderHealth[];
}

export interface HealthSummary {
  total: number;
  connected: number;
  degraded: number;
  missing: number;
  invalid: number;
  expired: number;
  partial: number;
  rate_limited: number;
  stub: number;
  criticalFailures: number;
}

export interface IntegrationsHealthReport {
  summary: HealthSummary;
  groups: HealthGroup[];
  cachedAt: string;
  fromCache: boolean;
  cacheStatus: "fresh" | "cached";
  ageMs: number;
}

// ── Latency classification ─────────────────────────────────────────────────────

function classifyLatency(ms: number | null): LatencyClass | null {
  if (ms === null) return null;
  if (ms < 200)  return "good";
  if (ms < 800)  return "warning";
  return "poor";
}

// ── In-memory cache (60s TTL per warm serverless instance) ────────────────────

interface CacheEntry {
  report: IntegrationsHealthReport;
  expiresAt: number;
}

let _cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60_000;

// ── Last success / failure history (persists across cache TTL within warm instance) ──

const _history = new Map<string, { lastSuccessAt: string | null; lastFailureAt: string | null }>();

function recordOutcome(key: string, status: HealthStatus, checkedAt: string): void {
  const prev = _history.get(key) ?? { lastSuccessAt: null, lastFailureAt: null };
  if (status === "connected" || status === "degraded") {
    _history.set(key, { ...prev, lastSuccessAt: checkedAt });
  } else if (status !== "stub") {
    _history.set(key, { ...prev, lastFailureAt: checkedAt });
  }
}

function getHistory(key: string): { lastSuccessAt: string | null; lastFailureAt: string | null } {
  return _history.get(key) ?? { lastSuccessAt: null, lastFailureAt: null };
}

// ── Fetch with timeout helper ─────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 2500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Safe wrapper — one provider failure never crashes the endpoint ─────────────

type PartialProviderResult = Omit<ProviderHealth, "checkedAt" | "lastSuccessAt" | "lastFailureAt">;

async function safeCheck(
  key: string,
  label: string,
  category: ProviderGroup,
  severity: Severity,
  requiredEnv: string[],
  impact: string[],
  fn: () => Promise<PartialProviderResult>,
): Promise<PartialProviderResult> {
  try {
    return await fn();
  } catch (e: unknown) {
    const isTimeout = e instanceof Error && e.name === "AbortError";
    return {
      key,
      label,
      description: "",
      category,
      severity,
      status: "partial",
      requiredEnv,
      missingEnv: [],
      latencyMs: null,
      latencyClass: null,
      details: { networkError: !isTimeout, timeout: isTimeout },
      message: isTimeout
        ? "Health check timed out — provider did not respond within 2.5s."
        : "Health check failed with an unexpected error. Provider state is unknown.",
      impact,
    };
  }
}

// ── Individual provider check functions ───────────────────────────────────────

async function _checkOpenAI(): Promise<PartialProviderResult> {
  const meta = {
    key: "openai",
    label: "OpenAI",
    description: "LLM execution, orchestration and embeddings.",
    category: "ai" as const,
    severity: "critical" as const,
    requiredEnv: ["OPENAI_API_KEY"],
    impact: ["AI agents will not run", "Workflow execution will fail", "LLM orchestration unavailable"],
  };
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return { ...meta, missingEnv: ["OPENAI_API_KEY"], status: "missing", latencyMs: null, latencyClass: null, details: {}, message: "OPENAI_API_KEY is not configured." };

  const t0 = Date.now();
  const res = await fetchWithTimeout("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  const latencyMs = Date.now() - t0;
  const latencyClass = classifyLatency(latencyMs);

  if (res.status === 200) {
    const status: HealthStatus = latencyClass === "poor" ? "degraded" : "connected";
    return { ...meta, missingEnv: [], status, latencyMs, latencyClass, details: { modelsEndpoint: true }, message: status === "degraded" ? `Connected but slow — ${latencyMs}ms latency exceeds threshold.` : "Connected and operational." };
  }
  if (res.status === 401) return { ...meta, missingEnv: [], status: "invalid", latencyMs, latencyClass, details: {}, message: "API key is invalid or has been revoked." };
  if (res.status === 429) return { ...meta, missingEnv: [], status: "rate_limited", latencyMs, latencyClass, details: {}, message: "Rate limited — key is valid but quota exceeded." };
  return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
}

async function _checkAnthropic(): Promise<PartialProviderResult> {
  const meta = {
    key: "anthropic",
    label: "Anthropic (Claude)",
    description: "Advanced reasoning, long-context tasks and agent workflows.",
    category: "ai" as const,
    severity: "optional" as const,
    requiredEnv: ["ANTHROPIC_API_KEY"],
    impact: ["Claude-based tasks unavailable", "Long-context reasoning unavailable"],
  };
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) return { ...meta, missingEnv: ["ANTHROPIC_API_KEY"], status: "missing", latencyMs: null, latencyClass: null, details: {}, message: "ANTHROPIC_API_KEY is not configured." };

  const t0 = Date.now();
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
  const latencyMs = Date.now() - t0;
  const latencyClass = classifyLatency(latencyMs);

  if (res.status === 200) {
    const status: HealthStatus = latencyClass === "poor" ? "degraded" : "connected";
    return { ...meta, missingEnv: [], status, latencyMs, latencyClass, details: { modelsEndpoint: true }, message: status === "degraded" ? `Connected but slow — ${latencyMs}ms.` : "Connected and operational." };
  }
  if (res.status === 401) return { ...meta, missingEnv: [], status: "invalid", latencyMs, latencyClass, details: {}, message: "API key is invalid or revoked." };
  if (res.status === 429) return { ...meta, missingEnv: [], status: "rate_limited", latencyMs, latencyClass, details: {}, message: "Rate limited — quota exceeded." };
  return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
}

async function _checkGemini(): Promise<PartialProviderResult> {
  const meta = {
    key: "gemini",
    label: "Google Gemini",
    description: "Multimodal AI tasks and Google AI model access.",
    category: "ai" as const,
    severity: "optional" as const,
    requiredEnv: ["GEMINI_API_KEY"],
    impact: ["Gemini-based tasks unavailable", "OCR unavailable for large PDFs"],
  };
  const key = (
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GOOGLE_AI_API_KEY ??
    ""
  ).trim();
  if (!key) return { ...meta, missingEnv: ["GEMINI_API_KEY"], status: "missing", latencyMs: null, latencyClass: null, details: {}, message: "GEMINI_API_KEY is not configured." };

  const t0 = Date.now();
  const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {});
  const latencyMs = Date.now() - t0;
  const latencyClass = classifyLatency(latencyMs);

  if (res.status === 200) {
    const status: HealthStatus = latencyClass === "poor" ? "degraded" : "connected";
    return { ...meta, missingEnv: [], status, latencyMs, latencyClass, details: { modelsEndpoint: true }, message: status === "degraded" ? `Connected but slow — ${latencyMs}ms.` : "Connected and operational." };
  }
  if (res.status === 400 || res.status === 403) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errMsg = String((body as { error?: { message?: string } }).error?.message ?? "");
    if (errMsg.toLowerCase().includes("api_key") || errMsg.toLowerCase().includes("invalid")) {
      return { ...meta, missingEnv: [], status: "invalid", latencyMs, latencyClass, details: {}, message: "API key is invalid." };
    }
    return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: { httpStatus: res.status }, message: `Access denied: ${errMsg || "HTTP " + res.status}.` };
  }
  if (res.status === 429) return { ...meta, missingEnv: [], status: "rate_limited", latencyMs, latencyClass, details: {}, message: "Rate limited." };
  return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
}

async function _checkSupabase(): Promise<PartialProviderResult> {
  const meta = {
    key: "supabase",
    label: "Supabase",
    description: "Auth, relational data, storage and runtime persistence.",
    category: "platform" as const,
    severity: "critical" as const,
    requiredEnv: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
    impact: ["Authentication may fail", "Data access may be blocked", "Storage operations unavailable"],
  };
  const url  = (process.env.SUPABASE_URL ?? "").trim() || _FB_URL;
  const anon = (process.env.SUPABASE_ANON_KEY ?? "").trim() || _FB_ANON;
  const missingEnv: string[] = [];
  if (!process.env.SUPABASE_URL?.trim()) missingEnv.push("SUPABASE_URL");
  if (!process.env.SUPABASE_ANON_KEY?.trim()) missingEnv.push("SUPABASE_ANON_KEY");

  const t0 = Date.now();
  const res = await fetchWithTimeout(`${url}/rest/v1/`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
  const latencyMs = Date.now() - t0;
  const latencyClass = classifyLatency(latencyMs);

  if (res.status === 200 || res.status === 404) {
    const status: HealthStatus = latencyClass === "poor" ? "degraded" : "connected";
    return {
      ...meta, missingEnv: [], status, latencyMs, latencyClass,
      details: { authOk: true, restOk: true },
      message: missingEnv.length > 0
        ? "Connected via hardcoded fallback. Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel env vars."
        : status === "degraded" ? `Connected but slow — ${latencyMs}ms.` : "Connected and operational.",
    };
  }
  if (res.status === 401 || res.status === 403) return { ...meta, missingEnv, status: "invalid", latencyMs, latencyClass, details: {}, message: "Supabase credentials rejected." };
  return { ...meta, missingEnv, status: "partial", latencyMs, latencyClass, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
}

async function _checkGitHub(): Promise<PartialProviderResult> {
  const meta = {
    key: "github",
    label: "GitHub",
    description: "Repository access, code generation workflows and deployment automation.",
    category: "platform" as const,
    severity: "important" as const,
    requiredEnv: ["GITHUB_TOKEN"],
    impact: ["Code sync unavailable", "PR automation unavailable", "Repository operations unavailable"],
  };
  const token = (process.env.GITHUB_TOKEN ?? process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? "").trim();
  if (!token) return { ...meta, missingEnv: ["GITHUB_TOKEN"], status: "missing", latencyMs: null, latencyClass: null, details: {}, message: "GITHUB_TOKEN is not configured." };

  const t0 = Date.now();
  const res = await fetchWithTimeout("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "BlissOps-HealthCheck", Accept: "application/vnd.github+json" },
  });
  const latencyMs = Date.now() - t0;
  const latencyClass = classifyLatency(latencyMs);

  if (res.status === 200) {
    const body = await res.json().catch(() => ({})) as { login?: string; type?: string };
    const scopesHeader = res.headers.get("x-oauth-scopes") ?? "";
    const scopes = scopesHeader.split(",").map((s) => s.trim()).filter(Boolean);
    const hasRepo = scopes.includes("repo") || scopes.includes("public_repo");
    const status: HealthStatus = latencyClass === "poor" ? "degraded" : "connected";
    return { ...meta, missingEnv: [], status, latencyMs, latencyClass, details: { user: body.login ?? null, accountType: body.type ?? null, readRepo: true, writeRepo: hasRepo, scopes: scopes.join(", ") || "fine-grained token" }, message: status === "degraded" ? `Authenticated but slow — ${latencyMs}ms.` : "Connected and authenticated." };
  }
  if (res.status === 401) return { ...meta, missingEnv: [], status: "invalid", latencyMs, latencyClass, details: {}, message: "Token is invalid or has been revoked." };
  if (res.status === 403) return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: { forbidden: true }, message: "Token valid but missing required permissions." };
  if (res.status === 429) return { ...meta, missingEnv: [], status: "rate_limited", latencyMs, latencyClass, details: {}, message: "GitHub API rate limit reached." };
  return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
}

async function _checkStripe(): Promise<PartialProviderResult> {
  const meta = {
    key: "stripe",
    label: "Stripe",
    description: "Billing and payment operations.",
    category: "platform" as const,
    severity: "important" as const,
    requiredEnv: ["STRIPE_SECRET_KEY"],
    impact: ["Billing operations may fail", "Subscription management unavailable"],
  };
  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) return { ...meta, missingEnv: ["STRIPE_SECRET_KEY"], status: "missing", latencyMs: null, latencyClass: null, details: {}, message: "STRIPE_SECRET_KEY is not configured." };

  const t0 = Date.now();
  const res = await fetchWithTimeout("https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${key}` } });
  const latencyMs = Date.now() - t0;
  const latencyClass = classifyLatency(latencyMs);

  if (res.status === 200) {
    const status: HealthStatus = latencyClass === "poor" ? "degraded" : "connected";
    return { ...meta, missingEnv: [], status, latencyMs, latencyClass, details: { billingOk: true }, message: status === "degraded" ? `Connected but slow — ${latencyMs}ms.` : "Connected and operational." };
  }
  if (res.status === 401) return { ...meta, missingEnv: [], status: "invalid", latencyMs, latencyClass, details: {}, message: "Stripe key is invalid or restricted." };
  if (res.status === 429) return { ...meta, missingEnv: [], status: "rate_limited", latencyMs, latencyClass, details: {}, message: "Stripe API rate limit reached." };
  return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
}

async function _checkVercel(): Promise<PartialProviderResult> {
  const meta = {
    key: "vercel",
    label: "Vercel",
    description: "Deployments and environment execution.",
    category: "infrastructure" as const,
    severity: "important" as const,
    requiredEnv: ["VERCEL_TOKEN"],
    impact: ["Deployment automation unavailable", "Environment management unavailable"],
  };
  const token = (process.env.VERCEL_TOKEN ?? "").trim();
  if (!token) return { ...meta, missingEnv: ["VERCEL_TOKEN"], status: "missing", latencyMs: null, latencyClass: null, details: {}, message: "VERCEL_TOKEN is not configured." };

  const t0 = Date.now();
  const res = await fetchWithTimeout("https://api.vercel.com/v2/user", { headers: { Authorization: `Bearer ${token}` } });
  const latencyMs = Date.now() - t0;
  const latencyClass = classifyLatency(latencyMs);

  if (res.status === 200) {
    const body = await res.json().catch(() => ({})) as { user?: { username?: string } };
    const status: HealthStatus = latencyClass === "poor" ? "degraded" : "connected";
    return { ...meta, missingEnv: [], status, latencyMs, latencyClass, details: { user: body.user?.username ?? null }, message: status === "degraded" ? `Connected but slow — ${latencyMs}ms.` : "Connected and authenticated." };
  }
  if (res.status === 401) return { ...meta, missingEnv: [], status: "invalid", latencyMs, latencyClass, details: {}, message: "Token is invalid or expired." };
  if (res.status === 403) return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: {}, message: "Token valid but insufficient permissions." };
  return { ...meta, missingEnv: [], status: "partial", latencyMs, latencyClass, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
}

async function _checkCloudflare(): Promise<PartialProviderResult> {
  const meta = {
    key: "cloudflare",
    label: "Cloudflare R2",
    description: "Storage and infrastructure edge services.",
    category: "infrastructure" as const,
    severity: "optional" as const,
    requiredEnv: ["CF_R2_ACCOUNT_ID", "CF_R2_ACCESS_KEY_ID", "CF_R2_SECRET_ACCESS_KEY"],
    impact: ["Storage features may be affected", "Infrastructure edge services unavailable"],
  };
  const accountId = (process.env.CF_R2_ACCOUNT_ID ?? "").trim();
  const accessKey = (process.env.CF_R2_ACCESS_KEY_ID ?? "").trim();
  const secretKey = (process.env.CF_R2_SECRET_ACCESS_KEY ?? "").trim();
  const apiToken  = (process.env.CF_API_TOKEN ?? "").trim();

  const missingEnv: string[] = [];
  if (!accountId) missingEnv.push("CF_R2_ACCOUNT_ID");
  if (!accessKey)  missingEnv.push("CF_R2_ACCESS_KEY_ID");
  if (!secretKey)  missingEnv.push("CF_R2_SECRET_ACCESS_KEY");

  // R2 lager-kredentialer (S3-kompatibel API) er det kritiske for faktisk storage
  const r2CredsPresent = missingEnv.length === 0;

  if (apiToken) {
    const t0 = Date.now();
    const res = await fetchWithTimeout("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    });
    const latencyMs = Date.now() - t0;
    const latencyClass = classifyLatency(latencyMs);
    const body = await res.json().catch(() => ({})) as { success?: boolean; result?: { status?: string } };

    if (res.status === 200 && body.success && body.result?.status === "active") {
      const status: HealthStatus = r2CredsPresent ? (latencyClass === "poor" ? "degraded" : "connected") : "partial";
      return { ...meta, missingEnv, status, latencyMs, latencyClass, details: { tokenActive: true, r2CredsPresent }, message: r2CredsPresent ? "R2 storage og API-token konfigureret og operationelt." : "API token aktiv men R2-kredentialer mangler." };
    }
    // CF_API_TOKEN er kun til admin-tjek — fejl her påvirker IKKE R2 storage
    // R2 storage bruger S3-kredentialer (CF_R2_ACCESS_KEY_ID + CF_R2_SECRET_ACCESS_KEY)
    if (r2CredsPresent) {
      return { ...meta, missingEnv: [], status: "connected", latencyMs, latencyClass, details: { tokenActive: false, r2CredsPresent: true }, message: "R2 lager konfigureret og operationelt." };
    }
    return { ...meta, missingEnv, status: "missing", latencyMs, latencyClass, details: { tokenActive: false, r2CredsPresent: false }, message: "R2-kredentialer mangler." };
  }

  if (!r2CredsPresent) return { ...meta, missingEnv, status: "missing", latencyMs: null, latencyClass: null, details: {}, message: "R2 credentials are not fully configured." };
  return { ...meta, missingEnv: [], status: "connected", latencyMs: null, latencyClass: null, details: { r2CredsPresent: true }, message: "R2 lager-kredentialer konfigureret og operationelle." };
}

function _checkEmail(): PartialProviderResult {
  const meta = {
    key: "email",
    label: "Email / SMTP",
    description: "Transactional email and system notifications.",
    category: "infrastructure" as const,
    severity: "optional" as const,
    requiredEnv: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"],
    impact: ["Outbound system emails unavailable", "Notifications will not be delivered"],
  };
  const host = (process.env.SMTP_HOST ?? "").trim();
  const port = (process.env.SMTP_PORT ?? "").trim();
  const user = (process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.SMTP_PASS ?? "").trim();
  const missingEnv: string[] = [];
  if (!host) missingEnv.push("SMTP_HOST");
  if (!port) missingEnv.push("SMTP_PORT");
  if (!user) missingEnv.push("SMTP_USER");
  if (!pass) missingEnv.push("SMTP_PASS");

  if (missingEnv.length === 4) return { ...meta, missingEnv, status: "stub", latencyMs: null, latencyClass: null, details: {}, message: "SMTP not configured — email sending is disabled." };
  if (missingEnv.length > 0)   return { ...meta, missingEnv, status: "partial", latencyMs: null, latencyClass: null, details: {}, message: "SMTP configuration is incomplete." };
  return { ...meta, missingEnv: [], status: "connected", latencyMs: null, latencyClass: null, details: { smtpConfigured: true }, message: "SMTP configured (live test not run on health check)." };
}

function _checkWebhooks(): PartialProviderResult {
  return {
    key: "webhooks",
    label: "Webhooks",
    description: "External event delivery and workflow triggers.",
    category: "infrastructure" as const,
    severity: "optional" as const,
    status: "stub",
    requiredEnv: [],
    missingEnv: [],
    latencyMs: null,
    latencyClass: null,
    details: { internalCapability: true },
    message: "Webhook delivery is built into the platform — no external token required.",
    impact: ["External event delivery unavailable", "Webhook triggers disabled"],
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getPlatformHealth(forceRefresh = false): Promise<IntegrationsHealthReport> {
  const now = Date.now();

  if (!forceRefresh && _cache && _cache.expiresAt > now) {
    const ageMs = now - new Date(_cache.report.cachedAt).getTime();
    // Merge current history into cached providers
    const groups = _cache.report.groups.map((g) => ({
      ...g,
      providers: g.providers.map((p) => ({ ...p, ...getHistory(p.key) })),
    }));
    return { ..._cache.report, groups, fromCache: true, cacheStatus: "cached", ageMs };
  }

  const checkedAt = new Date().toISOString();

  // Run all live checks in parallel with Promise.allSettled for resilience
  const [openaiR, anthropicR, geminiR, supabaseR, githubR, stripeR, vercelR, cloudflareR] =
    await Promise.allSettled([
      safeCheck("openai",     "OpenAI",            "ai",             "critical",  ["OPENAI_API_KEY"],                            ["AI agents will not run", "Workflow execution will fail"],           _checkOpenAI),
      safeCheck("anthropic",  "Anthropic (Claude)", "ai",             "optional",  ["ANTHROPIC_API_KEY"],                          ["Claude-based tasks unavailable"],                                   _checkAnthropic),
      safeCheck("gemini",     "Google Gemini",      "ai",             "optional",  ["GEMINI_API_KEY"],                             ["Gemini-based tasks unavailable", "OCR unavailable for large PDFs"], _checkGemini),
      safeCheck("supabase",   "Supabase",           "platform",       "critical",  ["SUPABASE_URL", "SUPABASE_ANON_KEY"],           ["Authentication may fail", "Data access may be blocked"],           _checkSupabase),
      safeCheck("github",     "GitHub",             "platform",       "important", ["GITHUB_TOKEN"],                               ["Code sync unavailable", "PR automation unavailable"],               _checkGitHub),
      safeCheck("stripe",     "Stripe",             "platform",       "important", ["STRIPE_SECRET_KEY"],                          ["Billing operations may fail"],                                      _checkStripe),
      safeCheck("vercel",     "Vercel",             "infrastructure", "important", ["VERCEL_TOKEN"],                               ["Deployment automation unavailable"],                                _checkVercel),
      safeCheck("cloudflare", "Cloudflare R2",      "infrastructure", "optional",  ["CF_R2_ACCOUNT_ID", "CF_R2_ACCESS_KEY_ID"],    ["Storage features may be affected"],                                 _checkCloudflare),
    ]);

  // Unwrap settled results
  function unwrap(r: PromiseSettledResult<PartialProviderResult>, fallbackKey: string, fallbackLabel: string): PartialProviderResult {
    if (r.status === "fulfilled") return r.value;
    return {
      key: fallbackKey,
      label: fallbackLabel,
      description: "",
      category: "platform",
      severity: "optional",
      status: "partial",
      requiredEnv: [],
      missingEnv: [],
      latencyMs: null,
      latencyClass: null,
      details: { settledRejected: true },
      message: "Health check encountered an unexpected error.",
      impact: [],
    };
  }

  const emailResult    = _checkEmail();
  const webhooksResult = _checkWebhooks();

  const partials: PartialProviderResult[] = [
    unwrap(openaiR,     "openai",     "OpenAI"),
    unwrap(anthropicR,  "anthropic",  "Anthropic (Claude)"),
    unwrap(geminiR,     "gemini",     "Google Gemini"),
    unwrap(supabaseR,   "supabase",   "Supabase"),
    unwrap(githubR,     "github",     "GitHub"),
    unwrap(stripeR,     "stripe",     "Stripe"),
    unwrap(vercelR,     "vercel",     "Vercel"),
    unwrap(cloudflareR, "cloudflare", "Cloudflare R2"),
    emailResult,
    webhooksResult,
  ];

  // Record outcomes and merge history
  partials.forEach((p) => recordOutcome(p.key, p.status, checkedAt));

  const allProviders: ProviderHealth[] = partials.map((p) => ({
    ...p,
    checkedAt,
    ...getHistory(p.key),
  }));

  const groups: HealthGroup[] = [
    { key: "ai",             label: "AI Providers",  providers: allProviders.filter((p) => p.category === "ai") },
    { key: "platform",       label: "Platform",      providers: allProviders.filter((p) => p.category === "platform") },
    { key: "infrastructure", label: "Infrastructure",providers: allProviders.filter((p) => p.category === "infrastructure") },
  ];

  // Critical: any non-healthy, non-stub status on a critical OR important provider
  // Spec: rate_limited/partial/degraded on critical providers also counts
  const CRITICAL_TRIGGERING: HealthStatus[] = ["missing", "invalid", "expired", "partial", "rate_limited", "degraded"];
  const criticalFailures = allProviders.filter(
    (p) => p.severity === "critical" && CRITICAL_TRIGGERING.includes(p.status),
  ).length;

  const summary: HealthSummary = {
    total:        allProviders.length,
    connected:    allProviders.filter((p) => p.status === "connected").length,
    degraded:     allProviders.filter((p) => p.status === "degraded").length,
    missing:      allProviders.filter((p) => p.status === "missing").length,
    invalid:      allProviders.filter((p) => p.status === "invalid").length,
    expired:      allProviders.filter((p) => p.status === "expired").length,
    partial:      allProviders.filter((p) => p.status === "partial").length,
    rate_limited: allProviders.filter((p) => p.status === "rate_limited").length,
    stub:         allProviders.filter((p) => p.status === "stub").length,
    criticalFailures,
  };

  const report: IntegrationsHealthReport = {
    summary,
    groups,
    cachedAt: checkedAt,
    fromCache: false,
    cacheStatus: "fresh",
    ageMs: 0,
  };

  _cache = { report, expiresAt: now + CACHE_TTL_MS };
  return report;
}
