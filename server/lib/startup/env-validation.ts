/**
 * Phase 28 — Environment Validation
 * Verifies required environment variables at startup.
 * Critical vars cause process exit; recommended vars emit warnings.
 */

export interface EnvVar {
  name: string;
  required: "critical" | "recommended" | "optional";
  description: string;
}

export interface EnvValidationResult {
  valid: boolean;
  criticalMissing: string[];
  recommendedMissing: string[];
  optionalMissing: string[];
  presentVars: string[];
  checkedAt: string;
}

// ── Variable registry ─────────────────────────────────────────────────────────

export const ENV_VAR_REGISTRY: EnvVar[] = [
  { name: "SUPABASE_URL",               required: "critical",    description: "Supabase project URL" },
  { name: "SUPABASE_SERVICE_ROLE_KEY",  required: "critical",    description: "Supabase service role key for admin access" },
  { name: "SUPABASE_DB_POOL_URL",       required: "critical",    description: "Supabase DB pool connection string" },
  { name: "OPENAI_API_KEY",             required: "recommended", description: "OpenAI API key for AI features" },
  { name: "STRIPE_SECRET_KEY",          required: "recommended", description: "Stripe secret key for billing" },
  { name: "WEBHOOK_SIGNING_SECRET",     required: "recommended", description: "Webhook payload signing secret" },
  { name: "SESSION_SECRET",             required: "recommended", description: "HTTP session signing secret" },
  { name: "GITHUB_TOKEN",              required: "optional",    description: "GitHub token for repo operations" },
];

// ── Validation logic ──────────────────────────────────────────────────────────

export function validateEnvironment(
  registry: EnvVar[] = ENV_VAR_REGISTRY,
  env: Record<string, string | undefined> = process.env,
): EnvValidationResult {
  const criticalMissing: string[]    = [];
  const recommendedMissing: string[] = [];
  const optionalMissing: string[]    = [];
  const presentVars: string[]        = [];

  for (const spec of registry) {
    const value = env[spec.name];
    if (value && value.trim() !== "") {
      presentVars.push(spec.name);
    } else {
      if (spec.required === "critical")    criticalMissing.push(spec.name);
      if (spec.required === "recommended") recommendedMissing.push(spec.name);
      if (spec.required === "optional")    optionalMissing.push(spec.name);
    }
  }

  return {
    valid: criticalMissing.length === 0,
    criticalMissing,
    recommendedMissing,
    optionalMissing,
    presentVars,
    checkedAt: new Date().toISOString(),
  };
}

// ── Startup gate — call once at boot ─────────────────────────────────────────

export function assertCriticalEnv(
  registry: EnvVar[] = ENV_VAR_REGISTRY,
  env: Record<string, string | undefined> = process.env,
): void {
  const result = validateEnvironment(registry, env);

  if (result.recommendedMissing.length > 0) {
    console.warn(
      `[env-validation] WARNING: recommended env vars missing: ${result.recommendedMissing.join(", ")}`,
    );
  }

  if (!result.valid) {
    const msg = `[env-validation] FATAL: critical env vars missing: ${result.criticalMissing.join(", ")}. Application cannot start.`;
    console.error(msg);
    process.exit(1);
  }

  console.log(
    `[env-validation] OK — ${result.presentVars.length} vars present, ${result.recommendedMissing.length} recommended missing (non-fatal)`,
  );
}

// ── Summary helper ────────────────────────────────────────────────────────────

export function getEnvSummary(
  registry: EnvVar[] = ENV_VAR_REGISTRY,
  env: Record<string, string | undefined> = process.env,
): Record<string, "present" | "missing-critical" | "missing-recommended" | "missing-optional"> {
  const summary: Record<string, "present" | "missing-critical" | "missing-recommended" | "missing-optional"> = {};
  for (const spec of registry) {
    const value = env[spec.name];
    if (value && value.trim() !== "") {
      summary[spec.name] = "present";
    } else {
      summary[spec.name] = `missing-${spec.required}` as any;
    }
  }
  return summary;
}
