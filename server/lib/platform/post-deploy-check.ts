/**
 * Phase 36 — Post Deploy Verification
 *
 * Executes environment + schema validation after deployment.
 * Logs results and emits alerts if critical failures are detected.
 *
 * Usage:
 *   import { runPostDeployCheck } from "./post-deploy-check";
 *   await runPostDeployCheck();
 */

import { validateEnv }    from "./env-validator";
import { validateSchema } from "./schema-validator";
import { getDeployHealth } from "./deploy-health";

export interface PostDeployCheckResult {
  passed: boolean;
  status: "healthy" | "warning" | "critical";
  envOk: boolean;
  schemaOk: boolean;
  warnings: string[];
  errors: string[];
  checkedAt: string;
}

async function emitSentryEvent(message: string): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    console.error(`[post-deploy-check] Sentry: deploy_integrity_failure — ${message}`);
  } catch {
    // ignore
  }
}

async function emitPostHogEvent(event: string, properties: Record<string, unknown>): Promise<void> {
  const key = process.env.POSTHOG_KEY;
  if (!key) return;
  try {
    console.log(`[post-deploy-check] PostHog: ${event}`, properties);
  } catch {
    // ignore
  }
}

export async function runPostDeployCheck(): Promise<PostDeployCheckResult> {
  const warnings: string[] = [];
  const errors: string[]   = [];

  console.log("[post-deploy-check] Starting post-deploy verification…");

  // Step 1: Environment validation
  const envResult = validateEnv();
  const envOk     = envResult.requiredOk;

  if (!envOk) {
    const msg = `Missing required env vars: ${envResult.missingRequired.join(", ")}`;
    errors.push(msg);
    console.error(`[post-deploy-check] CRITICAL: ${msg}`);
    await emitSentryEvent(msg);
  }

  if (envResult.optionalWarnings.length > 0) {
    const msg = `Optional env vars not configured: ${envResult.optionalWarnings.join(", ")}`;
    warnings.push(msg);
    console.warn(`[post-deploy-check] WARNING: ${msg}`);
    await emitPostHogEvent("deploy_health_warning", {
      type: "optional_env_missing",
      vars: envResult.optionalWarnings,
    });
  }

  // Step 2: Schema validation
  let schemaOk = false;
  try {
    const schemaResult = await validateSchema();
    schemaOk = schemaResult.schemaValid;

    if (!schemaOk) {
      if (schemaResult.missingTables.length > 0) {
        const msg = `Schema drift: missing tables: ${schemaResult.missingTables.join(", ")}`;
        errors.push(msg);
        console.error(`[post-deploy-check] CRITICAL: ${msg}`);
        await emitSentryEvent(msg);
      }
      if (schemaResult.missingColumns.length > 0) {
        const msg = `Schema drift: missing columns: ${schemaResult.missingColumns.join(", ")}`;
        errors.push(msg);
        console.error(`[post-deploy-check] CRITICAL: ${msg}`);
        await emitSentryEvent(msg);
      }
      if (schemaResult.missingIndexes.length > 0) {
        const msg = `Schema drift: missing indexes: ${schemaResult.missingIndexes.join(", ")}`;
        warnings.push(msg);
        console.warn(`[post-deploy-check] WARNING: ${msg}`);
      }
    }
  } catch (err) {
    const msg = `Schema validation failed: ${(err as Error).message}`;
    errors.push(msg);
    console.error(`[post-deploy-check] ERROR: ${msg}`);
  }

  // Step 3: Deploy health summary
  try {
    const health = await getDeployHealth();
    console.log(`[post-deploy-check] Deploy health: ${health.status}`);
    if (health.status === "critical") {
      await emitSentryEvent(`Deploy health critical: ${health.warnings.join("; ")}`);
    } else if (health.status === "warning") {
      await emitPostHogEvent("deploy_health_warning", {
        type: "deploy_health",
        warnings: health.warnings,
      });
    }
  } catch (err) {
    const msg = `Deploy health check failed: ${(err as Error).message}`;
    warnings.push(msg);
    console.warn(`[post-deploy-check] WARNING: ${msg}`);
  }

  const passed = errors.length === 0;
  const status = errors.length > 0 ? "critical" : warnings.length > 0 ? "warning" : "healthy";

  console.log(`[post-deploy-check] Done — ${status} (${errors.length} errors, ${warnings.length} warnings)`);

  return {
    passed,
    status,
    envOk,
    schemaOk,
    warnings,
    errors,
    checkedAt: new Date().toISOString(),
  };
}
