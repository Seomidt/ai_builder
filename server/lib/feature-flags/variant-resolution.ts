/**
 * Phase 18 — Variant Resolution
 * Deterministic flag and experiment resolution with full explainability.
 *
 * INV-FLAG2: Resolution order must be deterministic.
 * INV-FLAG3: Percentage/variant assignment must be deterministic.
 * INV-FLAG7: Resolution events must be explainable.
 * INV-FLAG8: Preview resolution must not write unexpectedly.
 */

import { createHash } from "crypto";
import { db } from "../../db.ts";
import { featureResolutionEvents } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

export interface ResolutionContext {
  tenantId?: string;
  actorId?: string;
  requestId?: string;
}

export interface ResolutionResult {
  flagKey: string;
  enabled: boolean | null;
  resolvedVariant: string | null;
  resolvedConfig: Record<string, unknown> | null;
  resolutionSource: string;
  explanation: string;
}

/**
 * Deterministic hash assignment.
 * Maps subjectKey + salt into a stable position in [0, 100).
 * INV-FLAG3: Same subject + same state → same result.
 */
export function deterministicHashAssignment(
  subjectKey: string,
  salt: string,
  thresholdPercent: number,
): boolean {
  if (thresholdPercent <= 0) return false;
  if (thresholdPercent >= 100) return true;
  const hash = createHash("sha256").update(`${subjectKey}::${salt}`).digest("hex");
  const bucket = parseInt(hash.slice(0, 8), 16) % 10000;
  return bucket < Math.round(thresholdPercent * 100);
}

/**
 * Map subject key + experiment + ordered cumulative buckets to a variant.
 * INV-FLAG3: deterministic for same subject + same variant list.
 */
export function deterministicVariantBucket(
  subjectKey: string,
  experimentKey: string,
  variants: Array<{ variantKey: string; trafficPercent: number }>,
): string | null {
  if (variants.length === 0) return null;
  const sorted = [...variants].sort((a, b) => a.variantKey.localeCompare(b.variantKey));
  const hash = createHash("sha256").update(`${subjectKey}::${experimentKey}`).digest("hex");
  const bucket = parseInt(hash.slice(0, 8), 16) % 10000;
  let cumulative = 0;
  for (const v of sorted) {
    cumulative += Math.round(v.trafficPercent * 100);
    if (bucket < cumulative) return v.variantKey;
  }
  return null;
}

/**
 * Resolve a feature flag for the given context.
 * Priority: actor → tenant → experiment → global → default
 * INV-FLAG2: Resolution order is deterministic.
 */
export async function resolveFeatureFlag(
  flagKey: string,
  ctx: ResolutionContext,
  options: { writeEvent?: boolean } = { writeEvent: true },
): Promise<ResolutionResult> {
  const flagRows = await db.execute(drizzleSql`
    SELECT id, flag_key, flag_type, default_enabled, default_config, lifecycle_status
    FROM feature_flags WHERE flag_key = ${flagKey} LIMIT 1
  `);
  const flag = flagRows.rows[0] as Record<string, unknown> | undefined;

  if (!flag || flag.lifecycle_status === "archived") {
    const result: ResolutionResult = {
      flagKey,
      enabled: false,
      resolvedVariant: null,
      resolvedConfig: null,
      resolutionSource: "default",
      explanation: flag ? "Flag is archived; defaulting to disabled" : "Flag not found; defaulting to disabled",
    };
    if (options.writeEvent !== false) await persistResolutionEvent(result, ctx);
    return result;
  }

  if (flag.lifecycle_status === "paused") {
    const result: ResolutionResult = {
      flagKey,
      enabled: Boolean(flag.default_enabled),
      resolvedVariant: null,
      resolvedConfig: flag.default_config as Record<string, unknown> | null,
      resolutionSource: "default",
      explanation: "Flag is paused; using default value",
    };
    if (options.writeEvent !== false) await persistResolutionEvent(result, ctx);
    return result;
  }

  // 1. Actor assignment (highest priority)
  if (ctx.actorId) {
    const actorRows = await db.execute(drizzleSql`
      SELECT ffa.id, ffa.enabled, ffa.assigned_variant, ffa.assigned_config
      FROM feature_flag_assignments ffa
      WHERE ffa.flag_id = ${flag.id as string}
        AND ffa.assignment_type = 'actor'
        AND ffa.actor_id = ${ctx.actorId}
      ORDER BY ffa.created_at DESC LIMIT 1
    `);
    if (actorRows.rows.length > 0) {
      const a = actorRows.rows[0] as Record<string, unknown>;
      const result: ResolutionResult = {
        flagKey,
        enabled: a.enabled !== null ? Boolean(a.enabled) : null,
        resolvedVariant: (a.assigned_variant as string) ?? null,
        resolvedConfig: (a.assigned_config as Record<string, unknown>) ?? null,
        resolutionSource: "actor_assignment",
        explanation: `Actor assignment matched for actor ${ctx.actorId}`,
      };
      if (options.writeEvent !== false) await persistResolutionEvent(result, ctx);
      return result;
    }
  }

  // 2. Tenant assignment
  if (ctx.tenantId) {
    const tenantRows = await db.execute(drizzleSql`
      SELECT ffa.id, ffa.enabled, ffa.assigned_variant, ffa.assigned_config
      FROM feature_flag_assignments ffa
      WHERE ffa.flag_id = ${flag.id as string}
        AND ffa.assignment_type = 'tenant'
        AND ffa.tenant_id = ${ctx.tenantId}
      ORDER BY ffa.created_at DESC LIMIT 1
    `);
    if (tenantRows.rows.length > 0) {
      const a = tenantRows.rows[0] as Record<string, unknown>;
      const result: ResolutionResult = {
        flagKey,
        enabled: a.enabled !== null ? Boolean(a.enabled) : null,
        resolvedVariant: (a.assigned_variant as string) ?? null,
        resolvedConfig: (a.assigned_config as Record<string, unknown>) ?? null,
        resolutionSource: "tenant_assignment",
        explanation: `Tenant assignment matched for tenant ${ctx.tenantId}`,
      };
      if (options.writeEvent !== false) await persistResolutionEvent(result, ctx);
      return result;
    }
  }

  // 3. Active experiment variant
  const subjectKey = ctx.actorId ?? ctx.tenantId ?? ctx.requestId ?? "anonymous";
  const expVariant = await resolveExperimentVariant(flagKey, ctx, { subjectKey });
  if (expVariant) {
    const result: ResolutionResult = {
      flagKey,
      enabled: true,
      resolvedVariant: expVariant.variantKey,
      resolvedConfig: expVariant.config,
      resolutionSource: "experiment_variant",
      explanation: `Experiment variant '${expVariant.variantKey}' assigned via deterministic hash`,
    };
    if (options.writeEvent !== false) await persistResolutionEvent(result, ctx);
    return result;
  }

  // 4. Global assignment
  const globalRows = await db.execute(drizzleSql`
    SELECT ffa.enabled, ffa.assigned_variant, ffa.assigned_config
    FROM feature_flag_assignments ffa
    WHERE ffa.flag_id = ${flag.id as string}
      AND ffa.assignment_type = 'global'
    ORDER BY ffa.created_at DESC LIMIT 1
  `);
  if (globalRows.rows.length > 0) {
    const a = globalRows.rows[0] as Record<string, unknown>;
    const result: ResolutionResult = {
      flagKey,
      enabled: a.enabled !== null ? Boolean(a.enabled) : null,
      resolvedVariant: (a.assigned_variant as string) ?? null,
      resolvedConfig: (a.assigned_config as Record<string, unknown>) ?? null,
      resolutionSource: "global_assignment",
      explanation: "Global assignment applied",
    };
    if (options.writeEvent !== false) await persistResolutionEvent(result, ctx);
    return result;
  }

  // 5. Flag default
  const result: ResolutionResult = {
    flagKey,
    enabled: Boolean(flag.default_enabled),
    resolvedVariant: null,
    resolvedConfig: (flag.default_config as Record<string, unknown>) ?? null,
    resolutionSource: "default",
    explanation: "No assignment found; using flag default",
  };
  if (options.writeEvent !== false) await persistResolutionEvent(result, ctx);
  return result;
}

/**
 * Resolve experiment variant for a flag key + subject.
 */
export async function resolveExperimentVariant(
  flagKey: string,
  ctx: ResolutionContext,
  opts?: { subjectKey?: string },
): Promise<{ variantKey: string; config: Record<string, unknown> | null } | null> {
  const subjectKey = opts?.subjectKey ?? ctx.actorId ?? ctx.tenantId ?? ctx.requestId ?? "anonymous";

  const expRows = await db.execute(drizzleSql`
    SELECT e.id, e.experiment_key, e.traffic_allocation_percent
    FROM experiments e
    WHERE e.experiment_key = ${flagKey}
      AND e.lifecycle_status = 'active'
    LIMIT 1
  `);
  if (expRows.rows.length === 0) return null;
  const exp = expRows.rows[0] as Record<string, unknown>;

  const alloc = Number(exp.traffic_allocation_percent ?? 100);
  if (!deterministicHashAssignment(subjectKey, `${exp.experiment_key as string}::traffic`, alloc)) {
    return null;
  }

  const variantRows = await db.execute(drizzleSql`
    SELECT variant_key, traffic_percent, config
    FROM experiment_variants
    WHERE experiment_id = ${exp.id as string}
    ORDER BY variant_key ASC
  `);
  const variants = variantRows.rows.map((r: Record<string, unknown>) => ({
    variantKey: r.variant_key as string,
    trafficPercent: Number(r.traffic_percent),
    config: (r.config as Record<string, unknown>) ?? null,
  }));
  if (variants.length === 0) return null;

  const assignedKey = deterministicVariantBucket(subjectKey, exp.experiment_key as string, variants);
  if (!assignedKey) return null;

  const variant = variants.find((v) => v.variantKey === assignedKey);
  return variant ? { variantKey: variant.variantKey, config: variant.config } : null;
}

/**
 * Preview resolution without writing an event (INV-FLAG8).
 */
export async function explainResolution(
  flagKey: string,
  ctx: ResolutionContext,
): Promise<ResolutionResult & { preview: true; noWritePerformed: true }> {
  const result = await resolveFeatureFlag(flagKey, ctx, { writeEvent: false });
  return { ...result, preview: true, noWritePerformed: true };
}

async function persistResolutionEvent(result: ResolutionResult, ctx: ResolutionContext): Promise<void> {
  try {
    await db.insert(featureResolutionEvents).values({
      tenantId: ctx.tenantId ?? null,
      actorId: ctx.actorId ?? null,
      requestId: ctx.requestId ?? null,
      flagKey: result.flagKey,
      resolutionSource: result.resolutionSource,
      enabled: result.enabled,
      resolvedVariant: result.resolvedVariant,
      resolvedConfig: result.resolvedConfig as Record<string, unknown> | null,
      metadata: { explanation: result.explanation } as Record<string, unknown>,
    });
  } catch {
    // INV-FLAG9: resolution event persistence failure must not break caller
  }
}
