/**
 * Phase 18 — Feature Flag Assignments
 * Per-tenant, per-actor, and global flag assignment management.
 *
 * INV-FLAG6: Rollout assignments must remain tenant-safe.
 * INV-FLAG2: Resolution order must be deterministic.
 */

import { db } from "../../db";
import { featureFlagAssignments, featureFlags } from "@shared/schema";
import { eq, sql as drizzleSql, and } from "drizzle-orm";

const VALID_ASSIGNMENT_TYPES = ["tenant", "actor", "global"] as const;

export interface AssignFlagParams {
  enabled?: boolean;
  assignedVariant?: string;
  assignedConfig?: Record<string, unknown> | null;
}

async function getFlagId(flagKey: string): Promise<string> {
  const rows = await db.execute(drizzleSql`
    SELECT id FROM feature_flags WHERE flag_key = ${flagKey} LIMIT 1
  `);
  const row = rows.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Feature flag not found: ${flagKey}`);
  return row.id as string;
}

export async function assignFlagToTenant(
  flagKey: string,
  tenantId: string,
  params: AssignFlagParams = {},
): Promise<{ id: string }> {
  const flagId = await getFlagId(flagKey);
  const rows = await db
    .insert(featureFlagAssignments)
    .values({
      flagId,
      tenantId,
      actorId: null,
      assignmentType: "tenant",
      enabled: params.enabled ?? null,
      assignedVariant: params.assignedVariant ?? null,
      assignedConfig: (params.assignedConfig ?? null) as Record<string, unknown> | null,
    })
    .returning({ id: featureFlagAssignments.id });
  return rows[0];
}

export async function assignFlagToActor(
  flagKey: string,
  actorId: string,
  params: AssignFlagParams & { tenantId?: string } = {},
): Promise<{ id: string }> {
  const flagId = await getFlagId(flagKey);
  const rows = await db
    .insert(featureFlagAssignments)
    .values({
      flagId,
      tenantId: params.tenantId ?? null,
      actorId,
      assignmentType: "actor",
      enabled: params.enabled ?? null,
      assignedVariant: params.assignedVariant ?? null,
      assignedConfig: (params.assignedConfig ?? null) as Record<string, unknown> | null,
    })
    .returning({ id: featureFlagAssignments.id });
  return rows[0];
}

export async function assignFlagGlobal(
  flagKey: string,
  params: AssignFlagParams = {},
): Promise<{ id: string }> {
  const flagId = await getFlagId(flagKey);
  const rows = await db
    .insert(featureFlagAssignments)
    .values({
      flagId,
      tenantId: null,
      actorId: null,
      assignmentType: "global",
      enabled: params.enabled ?? null,
      assignedVariant: params.assignedVariant ?? null,
      assignedConfig: (params.assignedConfig ?? null) as Record<string, unknown> | null,
    })
    .returning({ id: featureFlagAssignments.id });
  return rows[0];
}

export async function removeFlagAssignment(assignmentId: string): Promise<{ removed: boolean }> {
  const result = await db
    .delete(featureFlagAssignments)
    .where(eq(featureFlagAssignments.id, assignmentId))
    .returning({ id: featureFlagAssignments.id });
  return { removed: result.length > 0 };
}

export async function explainFlagAssignments(flagKey: string): Promise<{
  flagKey: string;
  assignments: Array<{
    id: string;
    assignmentType: string;
    tenantId: string | null;
    actorId: string | null;
    enabled: boolean | null;
    assignedVariant: string | null;
    createdAt: Date;
  }>;
}> {
  const rows = await db.execute(drizzleSql`
    SELECT ffa.id, ffa.assignment_type, ffa.tenant_id, ffa.actor_id, ffa.enabled,
           ffa.assigned_variant, ffa.created_at
    FROM feature_flag_assignments ffa
    JOIN feature_flags ff ON ff.id = ffa.flag_id
    WHERE ff.flag_key = ${flagKey}
    ORDER BY ffa.created_at DESC
  `);
  return {
    flagKey,
    assignments: rows.rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      assignmentType: r.assignment_type as string,
      tenantId: (r.tenant_id as string) ?? null,
      actorId: (r.actor_id as string) ?? null,
      enabled: r.enabled !== null ? Boolean(r.enabled) : null,
      assignedVariant: (r.assigned_variant as string) ?? null,
      createdAt: new Date(r.created_at as string),
    })),
  };
}
