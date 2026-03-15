/**
 * Phase 18 — Rollout Audit
 * Append-only audit log for all material rollout changes.
 *
 * INV-FLAG10: Audit records must be created for rollout changes.
 * Integrates with the canonical platform audit pattern.
 */

export type RolloutAuditAction =
  | "feature_flag.created"
  | "feature_flag.updated"
  | "feature_assignment.created"
  | "feature_assignment.removed"
  | "experiment.created"
  | "experiment.started"
  | "experiment.paused"
  | "experiment.completed"
  | "experiment_variant.created";

export interface RolloutAuditEntry {
  id: string;
  action: RolloutAuditAction;
  actorId: string | null;
  tenantId: string | null;
  subjectKey: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

// In-process append-only audit log (backed by DB in production via persist)
const _auditLog: RolloutAuditEntry[] = [];

function generateId(): string {
  return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function logRolloutChange(params: {
  action: RolloutAuditAction;
  subjectKey: string;
  actorId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; action: string }> {
  const entry: RolloutAuditEntry = {
    id: generateId(),
    action: params.action,
    actorId: params.actorId ?? null,
    tenantId: params.tenantId ?? null,
    subjectKey: params.subjectKey,
    metadata: params.metadata ?? {},
    createdAt: new Date(),
  };

  _auditLog.push(entry);

  // Also persist to DB for durability (non-blocking, fail-safe)
  try {
    const { db } = await import("../../db");
    const { sql: drizzleSql } = await import("drizzle-orm");
    await db.execute(drizzleSql`
      INSERT INTO rollout_audit_log (id, action, actor_id, tenant_id, subject_key, metadata, created_at)
      VALUES (${entry.id}, ${entry.action}, ${entry.actorId}, ${entry.tenantId},
              ${entry.subjectKey}, ${JSON.stringify(entry.metadata)}::jsonb, NOW())
      ON CONFLICT DO NOTHING
    `);
  } catch {
    // INV-FLAG9: audit persistence failure must never break caller
  }

  return { id: entry.id, action: entry.action };
}

export async function explainRolloutAudit(filter?: {
  action?: RolloutAuditAction;
  tenantId?: string;
  actorId?: string;
  subjectKey?: string;
  limit?: number;
}): Promise<{
  entries: RolloutAuditEntry[];
  total: number;
}> {
  const limit = Math.min(filter?.limit ?? 100, 1000);
  let filtered = [..._auditLog];

  if (filter?.action) filtered = filtered.filter((e) => e.action === filter.action);
  if (filter?.tenantId) filtered = filtered.filter((e) => e.tenantId === filter.tenantId);
  if (filter?.actorId) filtered = filtered.filter((e) => e.actorId === filter.actorId);
  if (filter?.subjectKey) filtered = filtered.filter((e) => e.subjectKey === filter.subjectKey);

  filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { entries: filtered.slice(0, limit), total: filtered.length };
}

/** Export the current log for testing (read-only view). */
export function getRolloutAuditLog(): Readonly<RolloutAuditEntry[]> {
  return Object.freeze([..._auditLog]);
}
