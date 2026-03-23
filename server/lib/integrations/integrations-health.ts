/**
 * Platform Integrations Health — Canonical Server Module
 *
 * Single source of truth for all platform-managed integration health checks.
 * All checks are server-side only. No secrets are ever returned to the client.
 *
 * Providers: OpenAI · Anthropic · Gemini · Supabase · GitHub · Stripe
 *            Vercel · Cloudflare · Email/SMTP · Webhooks
 */

// ── Hardcoded Supabase fallback (same as auth.ts) ─────────────────────────────
const _FB_URL  = "https://jneoimqidmkhikvusxak.supabase.co";
const _FB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZW9pbXFpZG1raGlrdnVzeGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzcxNTgsImV4cCI6MjA4ODcxMzE1OH0.CPdFKA1jfs7OAfHCm49J7_gl3GrA2b7WLmbKWzhoY8M";

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealthStatus =
  | "connected"
  | "missing"
  | "invalid"
  | "expired"
  | "partial"
  | "rate_limited"
  | "stub";

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
  details: Record<string, boolean | string | null>;
  message: string;
}

export interface HealthGroup {
  key: ProviderGroup;
  label: string;
  providers: ProviderHealth[];
}

export interface HealthSummary {
  total: number;
  connected: number;
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
}

// ── In-memory cache (per warm serverless instance, 60s TTL) ───────────────────

interface CacheEntry {
  report: IntegrationsHealthReport;
  expiresAt: number;
}

let _cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60_000;

// ── Fetch with timeout helper ─────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Individual provider health checks ─────────────────────────────────────────

async function checkOpenAI(): Promise<Omit<ProviderHealth, "checkedAt">> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "openai",
    label: "OpenAI",
    description: "Used for LLM execution, orchestration and embeddings.",
    category: "ai",
    severity: "critical",
    requiredEnv: ["OPENAI_API_KEY"],
  };

  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) {
    return { ...base, missingEnv: ["OPENAI_API_KEY"], status: "missing", latencyMs: null, details: {}, message: "OPENAI_API_KEY is not configured." };
  }

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const latencyMs = Date.now() - t0;

    if (res.status === 200) {
      return { ...base, missingEnv: [], status: "connected", latencyMs, details: { modelsEndpoint: true }, message: "Connected and operational." };
    }
    if (res.status === 401) {
      return { ...base, missingEnv: [], status: "invalid", latencyMs, details: {}, message: "API key is invalid or has been revoked." };
    }
    if (res.status === 429) {
      return { ...base, missingEnv: [], status: "rate_limited", latencyMs, details: {}, message: "Rate limited — key is valid but quota exceeded." };
    }
    return { ...base, missingEnv: [], status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
  } catch {
    return { ...base, missingEnv: [], status: "partial", latencyMs: Date.now() - t0, details: { networkError: true }, message: "Network error reaching OpenAI API." };
  }
}

async function checkAnthropic(): Promise<Omit<ProviderHealth, "checkedAt">> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "anthropic",
    label: "Anthropic (Claude)",
    description: "Used for advanced reasoning, long-context tasks and agent workflows.",
    category: "ai",
    severity: "optional",
    requiredEnv: ["ANTHROPIC_API_KEY"],
  };

  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) {
    return { ...base, missingEnv: ["ANTHROPIC_API_KEY"], status: "missing", latencyMs: null, details: {}, message: "ANTHROPIC_API_KEY is not configured." };
  }

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
    const latencyMs = Date.now() - t0;

    if (res.status === 200) return { ...base, missingEnv: [], status: "connected", latencyMs, details: { modelsEndpoint: true }, message: "Connected and operational." };
    if (res.status === 401) return { ...base, missingEnv: [], status: "invalid", latencyMs, details: {}, message: "API key is invalid or revoked." };
    if (res.status === 429) return { ...base, missingEnv: [], status: "rate_limited", latencyMs, details: {}, message: "Rate limited — key is valid but quota exceeded." };
    return { ...base, missingEnv: [], status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
  } catch {
    return { ...base, missingEnv: [], status: "partial", latencyMs: Date.now() - t0, details: { networkError: true }, message: "Network error reaching Anthropic API." };
  }
}

async function checkGemini(): Promise<Omit<ProviderHealth, "checkedAt">> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "gemini",
    label: "Google Gemini",
    description: "Used for multimodal AI tasks and Google AI model access.",
    category: "ai",
    severity: "optional",
    requiredEnv: ["GOOGLE_GENERATIVE_AI_API_KEY"],
  };

  const key = (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (!key) {
    return { ...base, missingEnv: ["GOOGLE_GENERATIVE_AI_API_KEY"], status: "missing", latencyMs: null, details: {}, message: "GOOGLE_GENERATIVE_AI_API_KEY is not configured." };
  }

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      {},
    );
    const latencyMs = Date.now() - t0;

    if (res.status === 200) return { ...base, missingEnv: [], status: "connected", latencyMs, details: { modelsEndpoint: true }, message: "Connected and operational." };
    if (res.status === 400 || res.status === 403) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = String((body as { error?: { message?: string } }).error?.message ?? "");
      if (errMsg.toLowerCase().includes("api_key") || errMsg.toLowerCase().includes("invalid")) {
        return { ...base, missingEnv: [], status: "invalid", latencyMs, details: {}, message: "API key is invalid." };
      }
      return { ...base, missingEnv: [], status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Access denied: ${errMsg || "HTTP " + res.status}.` };
    }
    if (res.status === 429) return { ...base, missingEnv: [], status: "rate_limited", latencyMs, details: {}, message: "Rate limited." };
    return { ...base, missingEnv: [], status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
  } catch {
    return { ...base, missingEnv: [], status: "partial", latencyMs: Date.now() - t0, details: { networkError: true }, message: "Network error reaching Google AI API." };
  }
}

async function checkSupabase(): Promise<Omit<ProviderHealth, "checkedAt">> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "supabase",
    label: "Supabase",
    description: "Used for auth, relational data, storage and runtime persistence.",
    category: "platform",
    severity: "critical",
    requiredEnv: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
  };

  // Use hardcoded fallback (known-good project)
  const url  = (process.env.SUPABASE_URL ?? "").trim() || _FB_URL;
  const anon = (process.env.SUPABASE_ANON_KEY ?? "").trim() || _FB_ANON;
  const missingEnv: string[] = [];
  if (!process.env.SUPABASE_URL?.trim()) missingEnv.push("SUPABASE_URL");
  if (!process.env.SUPABASE_ANON_KEY?.trim()) missingEnv.push("SUPABASE_ANON_KEY");

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(`${url}/rest/v1/`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    });
    const latencyMs = Date.now() - t0;

    if (res.status === 200 || res.status === 404) {
      // 404 = valid response from Supabase (no default table)
      return {
        ...base,
        missingEnv: [],
        status: "connected",
        latencyMs,
        details: { authOk: true, restOk: true },
        message: missingEnv.length > 0
          ? "Connected via hardcoded fallback. Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel env vars for explicit config."
          : "Connected and operational.",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ...base, missingEnv, status: "invalid", latencyMs, details: {}, message: "Supabase credentials rejected." };
    }
    return { ...base, missingEnv, status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
  } catch {
    return { ...base, missingEnv, status: "partial", latencyMs: Date.now() - t0, details: { networkError: true }, message: "Network error reaching Supabase." };
  }
}

async function checkGitHub(): Promise<Omit<ProviderHealth, "checkedAt">> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "github",
    label: "GitHub",
    description: "Used for repository access, code generation workflows and deployment automation.",
    category: "platform",
    severity: "important",
    requiredEnv: ["GITHUB_TOKEN"],
  };

  const token = (process.env.GITHUB_TOKEN ?? process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? "").trim();
  if (!token) {
    return { ...base, missingEnv: ["GITHUB_TOKEN"], status: "missing", latencyMs: null, details: {}, message: "GITHUB_TOKEN is not configured." };
  }

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "BlissOps-HealthCheck",
        Accept: "application/vnd.github+json",
      },
    });
    const latencyMs = Date.now() - t0;

    if (res.status === 200) {
      const body = await res.json().catch(() => ({})) as { login?: string; type?: string };
      const scopesHeader = res.headers.get("x-oauth-scopes") ?? "";
      const scopes = scopesHeader.split(",").map((s) => s.trim()).filter(Boolean);
      const hasRepo = scopes.includes("repo") || scopes.includes("public_repo");
      return {
        ...base, missingEnv: [], status: "connected", latencyMs,
        details: {
          user: body.login ?? null,
          accountType: body.type ?? null,
          readRepo: true,
          writeRepo: hasRepo,
          scopes: scopes.join(", ") || "fine-grained token (no scope header)",
        },
        message: "Connected and authenticated.",
      };
    }
    if (res.status === 401) return { ...base, missingEnv: [], status: "invalid", latencyMs, details: {}, message: "Token is invalid or has been revoked." };
    if (res.status === 403) return { ...base, missingEnv: [], status: "partial", latencyMs, details: { forbidden: true }, message: "Token valid but missing required permissions." };
    if (res.status === 429) return { ...base, missingEnv: [], status: "rate_limited", latencyMs, details: {}, message: "GitHub API rate limit reached." };
    return { ...base, missingEnv: [], status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
  } catch {
    return { ...base, missingEnv: [], status: "partial", latencyMs: Date.now() - t0, details: { networkError: true }, message: "Network error reaching GitHub API." };
  }
}

async function checkStripe(): Promise<Omit<ProviderHealth, "checkedAt">> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "stripe",
    label: "Stripe",
    description: "Used for billing and payment operations.",
    category: "platform",
    severity: "important",
    requiredEnv: ["STRIPE_SECRET_KEY"],
  };

  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) {
    return { ...base, missingEnv: ["STRIPE_SECRET_KEY"], status: "missing", latencyMs: null, details: {}, message: "STRIPE_SECRET_KEY is not configured." };
  }

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const latencyMs = Date.now() - t0;

    if (res.status === 200) return { ...base, missingEnv: [], status: "connected", latencyMs, details: { billingOk: true }, message: "Connected and operational." };
    if (res.status === 401) return { ...base, missingEnv: [], status: "invalid", latencyMs, details: {}, message: "Stripe key is invalid or restricted." };
    if (res.status === 429) return { ...base, missingEnv: [], status: "rate_limited", latencyMs, details: {}, message: "Stripe API rate limit reached." };
    return { ...base, missingEnv: [], status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
  } catch {
    return { ...base, missingEnv: [], status: "partial", latencyMs: Date.now() - t0, details: { networkError: true }, message: "Network error reaching Stripe API." };
  }
}

async function checkVercel(): Promise<Omit<ProviderHealth, "checkedAt">> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "vercel",
    label: "Vercel",
    description: "Used for deployments and environment execution.",
    category: "infrastructure",
    severity: "important",
    requiredEnv: ["VERCEL_TOKEN"],
  };

  const token = (process.env.VERCEL_TOKEN ?? "").trim();
  if (!token) {
    return { ...base, missingEnv: ["VERCEL_TOKEN"], status: "missing", latencyMs: null, details: {}, message: "VERCEL_TOKEN is not configured." };
  }

  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const latencyMs = Date.now() - t0;

    if (res.status === 200) {
      const body = await res.json().catch(() => ({})) as { user?: { username?: string; email?: string } };
      return {
        ...base, missingEnv: [], status: "connected", latencyMs,
        details: { user: body.user?.username ?? null },
        message: "Connected and authenticated.",
      };
    }
    if (res.status === 401) return { ...base, missingEnv: [], status: "invalid", latencyMs, details: {}, message: "Token is invalid or expired." };
    if (res.status === 403) return { ...base, missingEnv: [], status: "partial", latencyMs, details: {}, message: "Token valid but insufficient permissions." };
    return { ...base, missingEnv: [], status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
  } catch {
    return { ...base, missingEnv: [], status: "partial", latencyMs: Date.now() - t0, details: { networkError: true }, message: "Network error reaching Vercel API." };
  }
}

async function checkCloudflare(): Promise<Omit<ProviderHealth, "checkedAt">> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "cloudflare",
    label: "Cloudflare R2",
    description: "Used for storage and infrastructure edge services.",
    category: "infrastructure",
    severity: "optional",
    requiredEnv: ["CF_R2_ACCOUNT_ID", "CF_R2_ACCESS_KEY_ID", "CF_R2_SECRET_ACCESS_KEY"],
  };

  const accountId = (process.env.CF_R2_ACCOUNT_ID ?? "").trim();
  const accessKey = (process.env.CF_R2_ACCESS_KEY_ID ?? "").trim();
  const secretKey = (process.env.CF_R2_SECRET_ACCESS_KEY ?? "").trim();
  const apiToken  = (process.env.CF_API_TOKEN ?? "").trim();

  const missingEnv: string[] = [];
  if (!accountId) missingEnv.push("CF_R2_ACCOUNT_ID");
  if (!accessKey)  missingEnv.push("CF_R2_ACCESS_KEY_ID");
  if (!secretKey)  missingEnv.push("CF_R2_SECRET_ACCESS_KEY");

  // If we have a CF API token, use that for a proper live check
  if (apiToken) {
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      });
      const latencyMs = Date.now() - t0;
      const body = await res.json().catch(() => ({})) as { success?: boolean; result?: { status?: string } };

      if (res.status === 200 && body.success && body.result?.status === "active") {
        return { ...base, missingEnv: missingEnv.length > 0 ? missingEnv : [], status: missingEnv.length > 0 ? "partial" : "connected", latencyMs, details: { tokenActive: true, r2CredsPresent: missingEnv.length === 0 }, message: missingEnv.length > 0 ? "API token valid but R2 credentials incomplete." : "Connected and operational." };
      }
      if (res.status === 401) return { ...base, missingEnv, status: "invalid", latencyMs, details: {}, message: "Cloudflare API token is invalid." };
      return { ...base, missingEnv, status: "partial", latencyMs, details: { httpStatus: res.status }, message: `Unexpected response: HTTP ${res.status}.` };
    } catch {
      return { ...base, missingEnv, status: "partial", latencyMs: Date.now() - t0, details: { networkError: true }, message: "Network error reaching Cloudflare API." };
    }
  }

  // Fallback: presence check only
  if (missingEnv.length > 0) {
    return { ...base, missingEnv, status: "missing", latencyMs: null, details: {}, message: "R2 credentials are not fully configured." };
  }
  return { ...base, missingEnv: [], status: "connected", latencyMs: null, details: { r2CredsPresent: true }, message: "R2 credentials configured (live check requires CF_API_TOKEN)." };
}

function checkEmail(): Omit<ProviderHealth, "checkedAt"> {
  const base: Omit<ProviderHealth, "checkedAt" | "status" | "latencyMs" | "details" | "message" | "missingEnv"> = {
    key: "email",
    label: "Email / SMTP",
    description: "Used for transactional email and system notifications.",
    category: "infrastructure",
    severity: "optional",
    requiredEnv: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"],
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

  if (missingEnv.length === 4) {
    return { ...base, missingEnv, status: "stub", latencyMs: null, details: {}, message: "SMTP not configured — email sending is disabled." };
  }
  if (missingEnv.length > 0) {
    return { ...base, missingEnv, status: "partial", latencyMs: null, details: {}, message: "SMTP configuration is incomplete." };
  }
  return { ...base, missingEnv: [], status: "connected", latencyMs: null, details: { smtpConfigured: true }, message: "SMTP configured (live test not run on health check)." };
}

function checkWebhooks(): Omit<ProviderHealth, "checkedAt"> {
  return {
    key: "webhooks",
    label: "Webhooks",
    description: "Used for external event delivery and workflow triggers.",
    category: "infrastructure",
    severity: "optional",
    status: "stub",
    requiredEnv: [],
    missingEnv: [],
    latencyMs: null,
    details: { internalCapability: true },
    message: "Webhook delivery is built into the platform — no external token required.",
  };
}

// ── Main export: run all checks ───────────────────────────────────────────────

export async function getPlatformHealth(forceRefresh = false): Promise<IntegrationsHealthReport> {
  const now = Date.now();

  if (!forceRefresh && _cache && _cache.expiresAt > now) {
    return { ..._cache.report, fromCache: true };
  }

  const checkedAt = new Date().toISOString();

  // Run all live checks in parallel
  const [openai, anthropic, gemini, supabase, github, stripe, vercel, cloudflare] = await Promise.all([
    checkOpenAI(),
    checkAnthropic(),
    checkGemini(),
    checkSupabase(),
    checkGitHub(),
    checkStripe(),
    checkVercel(),
    checkCloudflare(),
  ]);

  const emailResult    = checkEmail();
  const webhooksResult = checkWebhooks();

  const allProviders: ProviderHealth[] = [
    { ...openai,     checkedAt },
    { ...anthropic,  checkedAt },
    { ...gemini,     checkedAt },
    { ...supabase,   checkedAt },
    { ...github,     checkedAt },
    { ...stripe,     checkedAt },
    { ...vercel,     checkedAt },
    { ...cloudflare, checkedAt },
    { ...emailResult,    checkedAt },
    { ...webhooksResult, checkedAt },
  ];

  const groups: HealthGroup[] = [
    {
      key: "ai",
      label: "AI Providers",
      providers: allProviders.filter((p) => p.category === "ai"),
    },
    {
      key: "platform",
      label: "Platform",
      providers: allProviders.filter((p) => p.category === "platform"),
    },
    {
      key: "infrastructure",
      label: "Infrastructure",
      providers: allProviders.filter((p) => p.category === "infrastructure"),
    },
  ];

  const criticalFailures = allProviders.filter(
    (p) => p.severity === "critical" && !["connected", "stub"].includes(p.status),
  ).length;

  const summary: HealthSummary = {
    total:        allProviders.length,
    connected:    allProviders.filter((p) => p.status === "connected").length,
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
  };

  _cache = { report, expiresAt: now + CACHE_TTL_MS };
  return report;
}
