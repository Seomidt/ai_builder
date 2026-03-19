/**
 * Phase 13 — Prompt Audit Service
 * Immutable audit log for all prompt governance events.
 * INV-PG13: Every governance action must be logged.
 * INV-PG14: Audit log is immutable — no updates or deletes.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export type ChangeType = "created" | "reviewed" | "approved" | "rejected" | "revoked" | "redteam_tested" | "policy_applied" | "executed";

export interface ChangeLogRecord {
  id: string;
  promptVersionId: string;
  changeType: ChangeType;
  changedBy: string;
  changeDescription: string;
  createdAt: Date;
}

function rowToLog(r: Record<string, unknown>): ChangeLogRecord {
  return {
    id: r["id"] as string,
    promptVersionId: r["prompt_version_id"] as string,
    changeType: r["change_type"] as ChangeType,
    changedBy: r["changed_by"] as string,
    changeDescription: r["change_description"] as string,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── logChange ────────────────────────────────────────────────────────────────
// INV-PG13: Called for every governance action. INV-PG14: INSERT only — no UPDATE/DELETE.
export async function logChange(params: {
  promptVersionId: string;
  changeType: ChangeType;
  changedBy: string;
  changeDescription: string;
  client?: pg.Client;
}): Promise<ChangeLogRecord> {
  const { promptVersionId, changeType, changedBy, changeDescription } = params;
  const useExt = !params.client;
  const client = params.client ?? getClient();
  if (useExt) await client.connect();

  try {
    const r = await client.query(
      `INSERT INTO public.prompt_change_log (id,prompt_version_id,change_type,changed_by,change_description)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4) RETURNING *`,
      [promptVersionId, changeType, changedBy, changeDescription],
    );
    return rowToLog(r.rows[0]);
  } finally {
    if (useExt) await client.end();
  }
}

// ─── getAuditLog ──────────────────────────────────────────────────────────────
export async function getAuditLog(params: {
  promptVersionId?: string;
  changedBy?: string;
  changeType?: ChangeType;
  limit?: number;
  offset?: number;
}): Promise<ChangeLogRecord[]> {
  const { promptVersionId, changedBy, changeType, limit = 50, offset = 0 } = params;
  const client = getClient();
  await client.connect();

  try {
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (promptVersionId) { conds.push(`prompt_version_id=$${vals.length + 1}`); vals.push(promptVersionId); }
    if (changedBy) { conds.push(`changed_by=$${vals.length + 1}`); vals.push(changedBy); }
    if (changeType) { conds.push(`change_type=$${vals.length + 1}`); vals.push(changeType); }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    vals.push(Math.min(limit, 200));
    vals.push(offset);

    const r = await client.query(
      `SELECT * FROM public.prompt_change_log ${where} ORDER BY created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    return r.rows.map(rowToLog);
  } finally {
    await client.end();
  }
}

// ─── governanceHealth ─────────────────────────────────────────────────────────
export async function governanceHealth(tenantId: string): Promise<{
  totalPolicies: number;
  activePolicies: number;
  totalReviews: number;
  approvedVersions: number;
  rejectedVersions: number;
  revokedVersions: number;
  totalViolations: number;
  totalRedteamTests: number;
  redteamPassRate: number;
  totalAuditEvents: number;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const [policies, approvals, reviews, violations, redteam, auditLogs] = await Promise.all([
      client.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN is_active THEN 1 END) as active FROM public.prompt_policies WHERE tenant_id=$1`, [tenantId]),
      client.query(
        `SELECT
           COUNT(CASE WHEN pa.approval_status='approved' THEN 1 END) as approved,
           COUNT(CASE WHEN pa.approval_status='rejected' THEN 1 END) as rejected,
           COUNT(CASE WHEN pa.approval_status='revoked' THEN 1 END) as revoked
         FROM public.prompt_approvals pa
         JOIN public.ai_prompt_versions apv ON apv.id = pa.prompt_version_id
         JOIN public.ai_prompts ap ON ap.id = apv.prompt_id AND ap.tenant_id = $1`,
        [tenantId],
      ),
      client.query(
        `SELECT COUNT(*) as cnt FROM public.prompt_reviews pr
         JOIN public.ai_prompt_versions apv ON apv.id = pr.prompt_version_id
         JOIN public.ai_prompts ap ON ap.id = apv.prompt_id AND ap.tenant_id = $1`,
        [tenantId],
      ),
      client.query(
        `SELECT COUNT(*) as cnt FROM public.prompt_policy_violations ppv
         JOIN public.prompt_policies pp ON pp.id = ppv.policy_id AND pp.tenant_id = $1`,
        [tenantId],
      ),
      client.query(
        `SELECT COUNT(*) as total, COUNT(CASE WHEN test_result='passed' THEN 1 END) as passed
         FROM public.prompt_redteam_tests prt
         JOIN public.ai_prompt_versions apv ON apv.id = prt.prompt_version_id
         JOIN public.ai_prompts ap ON ap.id = apv.prompt_id AND ap.tenant_id = $1`,
        [tenantId],
      ),
      client.query(
        `SELECT COUNT(*) as cnt FROM public.prompt_change_log pcl
         JOIN public.ai_prompt_versions apv ON apv.id = pcl.prompt_version_id
         JOIN public.ai_prompts ap ON ap.id = apv.prompt_id AND ap.tenant_id = $1`,
        [tenantId],
      ),
    ]);

    const totalTests = parseInt(redteam.rows[0].total, 10);
    const passedTests = parseInt(redteam.rows[0].passed, 10);

    return {
      totalPolicies: parseInt(policies.rows[0].total, 10),
      activePolicies: parseInt(policies.rows[0].active, 10),
      totalReviews: parseInt(reviews.rows[0].cnt, 10),
      approvedVersions: parseInt(approvals.rows[0].approved, 10),
      rejectedVersions: parseInt(approvals.rows[0].rejected, 10),
      revokedVersions: parseInt(approvals.rows[0].revoked, 10),
      totalViolations: parseInt(violations.rows[0].cnt, 10),
      totalRedteamTests: totalTests,
      redteamPassRate: totalTests > 0 ? parseFloat(((passedTests / totalTests) * 100).toFixed(1)) : 0,
      totalAuditEvents: parseInt(auditLogs.rows[0].cnt, 10),
      note: "INV-PG13: All governance events logged. INV-PG14: Audit log is immutable.",
    };
  } finally {
    await client.end();
  }
}
