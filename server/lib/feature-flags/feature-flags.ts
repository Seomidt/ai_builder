/**
 * Phase 18 — Feature Flags Service
 * Canonical flag registry CRUD and lifecycle management.
 *
 * INV-FLAG1: Feature flags must have canonical unique keys.
 * INV-FLAG5: Pause/complete lifecycle transitions must be explicit.
 */

import { db } from "../../db.ts";
import { featureFlags } from "@shared/schema";
import { eq, desc, sql as drizzleSql } from "drizzle-orm";

const VALID_FLAG_TYPES = ["boolean", "percentage_rollout", "experiment", "config_switch"] as const;
const VALID_LIFECYCLES = ["active", "paused", "archived"] as const;

export interface CreateFeatureFlagParams {
  flagKey: string;
  flagType: string;
  description?: string;
  defaultEnabled?: boolean;
  defaultConfig?: Record<string, unknown> | null;
}

export interface UpdateFeatureFlagParams {
  description?: string;
  defaultEnabled?: boolean;
  defaultConfig?: Record<string, unknown> | null;
  lifecycleStatus?: string;
}

export async function createFeatureFlag(params: CreateFeatureFlagParams): Promise<{ id: string; flagKey: string }> {
  if (!params.flagKey || !params.flagKey.trim()) {
    throw new Error("flagKey is required");
  }
  if (!VALID_FLAG_TYPES.includes(params.flagType as (typeof VALID_FLAG_TYPES)[number])) {
    throw new Error(`Invalid flagType: ${params.flagType}. Must be one of: ${VALID_FLAG_TYPES.join(", ")}`);
  }
  const rows = await db
    .insert(featureFlags)
    .values({
      flagKey: params.flagKey.trim(),
      flagType: params.flagType,
      description: params.description ?? null,
      defaultEnabled: params.defaultEnabled ?? false,
      defaultConfig: (params.defaultConfig ?? null) as Record<string, unknown> | null,
      lifecycleStatus: "active",
    })
    .returning({ id: featureFlags.id, flagKey: featureFlags.flagKey });
  return rows[0];
}

export async function updateFeatureFlag(
  flagKey: string,
  updates: UpdateFeatureFlagParams,
): Promise<{ updated: boolean }> {
  if (updates.lifecycleStatus && !VALID_LIFECYCLES.includes(updates.lifecycleStatus as (typeof VALID_LIFECYCLES)[number])) {
    throw new Error(`Invalid lifecycleStatus: ${updates.lifecycleStatus}`);
  }
  const result = await db
    .update(featureFlags)
    .set({
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.defaultEnabled !== undefined ? { defaultEnabled: updates.defaultEnabled } : {}),
      ...(updates.defaultConfig !== undefined ? { defaultConfig: updates.defaultConfig as Record<string, unknown> | null } : {}),
      ...(updates.lifecycleStatus !== undefined ? { lifecycleStatus: updates.lifecycleStatus } : {}),
      updatedAt: new Date(),
    })
    .where(eq(featureFlags.flagKey, flagKey))
    .returning({ id: featureFlags.id });
  return { updated: result.length > 0 };
}

export async function listFeatureFlags(filter?: {
  lifecycleStatus?: string;
  flagType?: string;
  limit?: number;
}): Promise<Array<{ id: string; flagKey: string; flagType: string; lifecycleStatus: string; defaultEnabled: boolean; description: string | null; createdAt: Date }>> {
  const limit = Math.min(filter?.limit ?? 100, 500);
  const rows = await db.execute(drizzleSql`
    SELECT id, flag_key, flag_type, lifecycle_status, default_enabled, description, created_at
    FROM feature_flags
    WHERE 1=1
      ${filter?.lifecycleStatus ? drizzleSql`AND lifecycle_status = ${filter.lifecycleStatus}` : drizzleSql``}
      ${filter?.flagType ? drizzleSql`AND flag_type = ${filter.flagType}` : drizzleSql``}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return rows.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    flagKey: r.flag_key as string,
    flagType: r.flag_type as string,
    lifecycleStatus: r.lifecycle_status as string,
    defaultEnabled: Boolean(r.default_enabled),
    description: (r.description as string) ?? null,
    createdAt: new Date(r.created_at as string),
  }));
}

export async function explainFeatureFlag(flagKey: string): Promise<{
  flag: Record<string, unknown> | null;
  assignmentCount: number;
  resolutionEventCount: number;
}> {
  const flagRows = await db.execute(drizzleSql`
    SELECT * FROM feature_flags WHERE flag_key = ${flagKey} LIMIT 1
  `);
  const flag = flagRows.rows[0] ?? null;

  const assignRows = await db.execute(drizzleSql`
    SELECT COUNT(*) AS cnt FROM feature_flag_assignments ffa
    JOIN feature_flags ff ON ff.id = ffa.flag_id
    WHERE ff.flag_key = ${flagKey}
  `);
  const assignmentCount = Number((assignRows.rows[0] as Record<string, unknown>)?.cnt ?? 0);

  const evtRows = await db.execute(drizzleSql`
    SELECT COUNT(*) AS cnt FROM feature_resolution_events WHERE flag_key = ${flagKey}
  `);
  const resolutionEventCount = Number((evtRows.rows[0] as Record<string, unknown>)?.cnt ?? 0);

  return { flag: flag as Record<string, unknown> | null, assignmentCount, resolutionEventCount };
}
