/**
 * Phase 33 — Ops AI Audit Logger
 *
 * TASK 8: All assistant runs must be logged.
 * Tracks: request timestamp, operator id, input scope, response summary,
 *         confidence, tokens used, model used.
 * Secrets are never stored — raw payload excerpts are redacted.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  requestType:     string;
  operatorId:      string | null;
  inputScope:      Record<string, unknown>;
  responseSummary: string | null;
  confidence:      string | null;
  tokensUsed:      number | null;
  modelUsed:       string | null;
}

export interface AuditRecord extends AuditEntry {
  id:        string;
  createdAt: string;
}

// ── Secret redaction ──────────────────────────────────────────────────────────

const SECRET_KEYS = new Set([
  "apikey", "api_key", "secret", "token", "password", "credential",
  "authorization", "auth", "key", "webhook_secret", "service_role",
  "anon_key", "private_key", "access_token", "refresh_token",
]);

export function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactSecrets(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 5); // bound array size
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Write audit record ────────────────────────────────────────────────────────

export async function writeAuditRecord(entry: AuditEntry): Promise<string> {
  try {
    const safeScope = redactSecrets(entry.inputScope);
    const summaryTrunc = entry.responseSummary
      ? entry.responseSummary.slice(0, 500)
      : null;

    const res = await db.execute<{ id: string }>(sql`
      INSERT INTO ops_ai_audit_logs
        (request_type, operator_id, input_scope, response_summary, confidence, tokens_used, model_used)
      VALUES
        (${entry.requestType}, ${entry.operatorId}, ${JSON.stringify(safeScope)},
         ${summaryTrunc}, ${entry.confidence}, ${entry.tokensUsed}, ${entry.modelUsed})
      RETURNING id
    `);
    return res.rows[0]?.id ?? "unknown";
  } catch (err) {
    // Audit failures must never crash the main request — log and continue
    console.error("[ops-ai-audit] Failed to write audit record:", (err as Error).message);
    return "audit-write-failed";
  }
}

// ── Read audit history ────────────────────────────────────────────────────────

export async function listAuditRecords(limit = 50): Promise<AuditRecord[]> {
  try {
    const res = await db.execute<any>(sql`
      SELECT
        id, request_type, operator_id, input_scope, response_summary,
        confidence, tokens_used, model_used,
        created_at::text AS created_at
      FROM ops_ai_audit_logs
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return res.rows.map((r) => ({
      id:              r.id,
      requestType:     r.request_type,
      operatorId:      r.operator_id ?? null,
      inputScope:      (typeof r.input_scope === "string" ? JSON.parse(r.input_scope) : r.input_scope) ?? {},
      responseSummary: r.response_summary ?? null,
      confidence:      r.confidence ?? null,
      tokensUsed:      r.tokens_used != null ? Number(r.tokens_used) : null,
      modelUsed:       r.model_used ?? null,
      createdAt:       r.created_at,
    }));
  } catch (err) {
    console.error("[ops-ai-audit] listAuditRecords failed:", (err as Error).message);
    return [];
  }
}
