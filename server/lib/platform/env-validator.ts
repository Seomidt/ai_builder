/**
 * Phase 36 — Environment Validation Service
 *
 * Validates required and optional environment variables at runtime.
 * Used during startup and by the deploy-health aggregator.
 * Never exposes secret values — only names.
 */

export const REQUIRED_ENV_VARS: readonly string[] = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "SESSION_SECRET",
] as const;

export const OPTIONAL_ENV_VARS: readonly string[] = [
  "SENTRY_DSN",
  "POSTHOG_KEY",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

export interface EnvValidationResult {
  requiredOk: boolean;
  missingRequired: string[];
  optionalWarnings: string[];
  presentRequired: string[];
  presentOptional: string[];
  checkedAt: string;
}

/**
 * Validates environment variables.
 * Does NOT expose values — only names.
 */
export function validateEnv(): EnvValidationResult {
  const missingRequired: string[] = [];
  const presentRequired: string[] = [];
  const optionalWarnings: string[] = [];
  const presentOptional: string[] = [];

  for (const varName of REQUIRED_ENV_VARS) {
    const val = process.env[varName];
    if (!val || val.trim() === "") {
      missingRequired.push(varName);
    } else {
      presentRequired.push(varName);
    }
  }

  for (const varName of OPTIONAL_ENV_VARS) {
    const val = process.env[varName];
    if (!val || val.trim() === "") {
      optionalWarnings.push(varName);
    } else {
      presentOptional.push(varName);
    }
  }

  return {
    requiredOk: missingRequired.length === 0,
    missingRequired,
    optionalWarnings,
    presentRequired,
    presentOptional,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Throws if any required env var is missing.
 * Call at application startup.
 */
export function assertEnv(): void {
  const result = validateEnv();
  if (!result.requiredOk) {
    throw new Error(
      `Missing required environment variables: ${result.missingRequired.join(", ")}. ` +
        "Application cannot start.",
    );
  }
}
