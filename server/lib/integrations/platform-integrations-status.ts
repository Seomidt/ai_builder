/**
 * Platform Integrations Status Service
 *
 * SERVER-ONLY — never import from client/.
 *
 * Returns safe, typed status objects for all platform integrations.
 * Rules:
 *   - Never returns secret values — only env var NAMES
 *   - Never fakes healthy status
 *   - Providers not yet implemented show as "stub"
 */

export type ProviderStatus = "healthy" | "warning" | "missing" | "stub";
export type ProviderCategory = "ai" | "platform" | "infra";

export interface IntegrationStatus {
  key: string;
  label: string;
  category: ProviderCategory;
  configured: boolean;
  status: ProviderStatus;
  message: string;
  requiredEnvVars: string[];
  missingEnvVars: string[];
  docsHint?: string;
}

export interface PlatformIntegrationsReport {
  providers: IntegrationStatus[];
  summary: {
    total: number;
    healthy: number;
    missing: number;
    warning: number;
    stub: number;
  };
  generatedAt: string;
}

function hasEnv(...keys: string[]): { ok: boolean; missing: string[] } {
  const missing = keys.filter((k) => !process.env[k]);
  return { ok: missing.length === 0, missing };
}

function buildStatus(
  opts: Omit<IntegrationStatus, "configured" | "status" | "missingEnvVars"> & {
    requiredEnvVars: string[];
    stubIfAllMissing?: boolean;
  },
): IntegrationStatus {
  const { ok, missing } = hasEnv(...opts.requiredEnvVars);
  const configured = ok;

  let status: ProviderStatus;
  if (configured) {
    status = "healthy";
  } else if (opts.stubIfAllMissing && missing.length === opts.requiredEnvVars.length) {
    status = "stub";
  } else {
    status = "missing";
  }

  const message = configured
    ? opts.message
    : `Missing: ${missing.join(", ")}`;

  return {
    key: opts.key,
    label: opts.label,
    category: opts.category,
    configured,
    status,
    message,
    requiredEnvVars: opts.requiredEnvVars,
    missingEnvVars: missing,
    docsHint: opts.docsHint,
  };
}

export function getPlatformIntegrationsStatus(): PlatformIntegrationsReport {
  const providers: IntegrationStatus[] = [
    // ── AI Providers ──────────────────────────────────────────────────────────
    buildStatus({
      key: "openai",
      label: "OpenAI",
      category: "ai",
      requiredEnvVars: ["OPENAI_API_KEY"],
      message: "API key configured. Active provider for Ops Assistant and AI pipeline.",
      docsHint: "Set OPENAI_API_KEY in environment secrets.",
    }),
    buildStatus({
      key: "anthropic",
      label: "Anthropic / Claude",
      category: "ai",
      requiredEnvVars: ["ANTHROPIC_API_KEY"],
      message: "API key configured. Available for reasoning-heavy tasks.",
      stubIfAllMissing: true,
      docsHint: "Set ANTHROPIC_API_KEY to enable Claude models.",
    }),
    buildStatus({
      key: "gemini",
      label: "Google Gemini",
      category: "ai",
      requiredEnvVars: ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
      message: "API key configured. Active for OCR and cost-efficient AI tasks.",
      stubIfAllMissing: true,
      docsHint: "Set GEMINI_API_KEY to enable Gemini models and OCR.",
    }),

    // ── Platform ──────────────────────────────────────────────────────────────
    buildStatus({
      key: "supabase",
      label: "Supabase",
      category: "platform",
      requiredEnvVars: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
      message: "Auth and database layer connected.",
      docsHint: "Core dependency — must be configured for the platform to function.",
    }),
    buildStatus({
      key: "github",
      label: "GitHub",
      category: "platform",
      requiredEnvVars: ["GITHUB_TOKEN"],
      message: "Token configured. Code generation and PR workflows enabled.",
      docsHint: "Set GITHUB_TOKEN with repo write permissions.",
    }),
    buildStatus({
      key: "stripe",
      label: "Stripe",
      category: "platform",
      requiredEnvVars: ["STRIPE_SECRET_KEY"],
      message: "Secret key configured. Billing and checkout enabled.",
      stubIfAllMissing: true,
      docsHint: "Set STRIPE_SECRET_KEY to enable billing features.",
    }),

    // ── Infra ─────────────────────────────────────────────────────────────────
    buildStatus({
      key: "vercel",
      label: "Vercel",
      category: "infra",
      requiredEnvVars: ["VERCEL_TOKEN"],
      message: "Token configured. Deployment integration enabled.",
      stubIfAllMissing: true,
      docsHint: "Set VERCEL_TOKEN for deployment automation.",
    }),
    buildStatus({
      key: "cloudflare",
      label: "Cloudflare",
      category: "infra",
      requiredEnvVars: ["CF_API_TOKEN"],
      message: "API token configured. DNS and edge layer managed.",
      docsHint: "CF_API_TOKEN is configured via environment secrets.",
    }),
    buildStatus({
      key: "email",
      label: "Email / SMTP",
      category: "infra",
      requiredEnvVars: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"],
      message: "SMTP configured. Transactional email enabled.",
      stubIfAllMissing: true,
      docsHint: "Set SMTP_HOST, SMTP_USER, SMTP_PASS for email delivery.",
    }),
    buildStatus({
      key: "webhooks",
      label: "Webhooks",
      category: "infra",
      requiredEnvVars: ["WEBHOOK_SECRET"],
      message: "Webhook secret configured. Inbound webhook verification enabled.",
      stubIfAllMissing: true,
      docsHint: "Set WEBHOOK_SECRET to enable verified inbound webhooks.",
    }),
  ];

  // Gemini: special handling — any of the three key names counts as configured
  const geminiEntry = providers.find((p) => p.key === "gemini")!;
  const geminiOk = !!(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
  );
  if (geminiOk) {
    geminiEntry.configured = true;
    geminiEntry.status = "healthy";
    geminiEntry.missingEnvVars = [];
    geminiEntry.message = "API key configured. Available for cost-efficient tasks.";
  }

  const summary = {
    total: providers.length,
    healthy: providers.filter((p) => p.status === "healthy").length,
    missing: providers.filter((p) => p.status === "missing").length,
    warning: providers.filter((p) => p.status === "warning").length,
    stub: providers.filter((p) => p.status === "stub").length,
  };

  return { providers, summary, generatedAt: new Date().toISOString() };
}
