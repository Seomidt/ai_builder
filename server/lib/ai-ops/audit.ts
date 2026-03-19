// ─── Phase 51: AI Ops Assistant — Audit Logging ───────────────────────────────
//
// Logs AI Ops usage safely.
// Tracks: who, what intent, what scope, when, success/failure.
// Never dumps raw sensitive context into logs.
// ─────────────────────────────────────────────────────────────────────────────

export interface AiOpsAuditEntry {
  auditId: string;
  userId: string;
  intent: string;
  scope: "platform" | "tenant";
  organizationId?: string;
  success: boolean;
  errorMessage?: string;
  timestamp?: string;
}

const auditLog: AiOpsAuditEntry[] = [];

export async function logAiOpsAudit(entry: AiOpsAuditEntry): Promise<void> {
  const record: AiOpsAuditEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
    errorMessage: entry.errorMessage?.substring(0, 200),
  };

  auditLog.push(record);

  if (auditLog.length > 500) {
    auditLog.splice(0, auditLog.length - 500);
  }

  const logLine = JSON.stringify({
    type: "ai_ops_audit",
    auditId: record.auditId,
    userId: record.userId,
    intent: record.intent,
    scope: record.scope,
    orgId: record.organizationId ?? null,
    success: record.success,
    error: record.errorMessage ?? null,
    ts: record.timestamp,
  });

  if (record.success) {
    console.log(`[AI-OPS-AUDIT] ${logLine}`);
  } else {
    console.warn(`[AI-OPS-AUDIT-FAIL] ${logLine}`);
  }
}

export function getRecentAuditLog(limit = 50): AiOpsAuditEntry[] {
  return auditLog.slice(-limit).reverse();
}

export function getAuditStats(): {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  intentBreakdown: Record<string, number>;
} {
  const intentBreakdown: Record<string, number> = {};
  let successCount = 0;
  let failureCount = 0;

  for (const entry of auditLog) {
    intentBreakdown[entry.intent] = (intentBreakdown[entry.intent] ?? 0) + 1;
    if (entry.success) successCount++;
    else failureCount++;
  }

  return {
    totalRequests: auditLog.length,
    successCount,
    failureCount,
    intentBreakdown,
  };
}

export const AI_OPS_AUDIT_CONFIG = {
  maxInMemoryEntries: 500,
  logPrefix: "[AI-OPS-AUDIT]",
  version: "phase51",
};
