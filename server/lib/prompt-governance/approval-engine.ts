/**
 * Phase 13 — Approval Engine
 * Controls the approval lifecycle for prompt versions.
 * INV-PG6: Only approved prompt versions may be executed.
 * INV-PG7: Approval requires a passed review.
 * INV-PG8: Approval is a unique record per version (one approval per version).
 */

import pg from "pg";
import { getLatestReview, isReviewPassed } from "./prompt-review";
import { logChange } from "./prompt-audit";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "revoked";

export interface ApprovalRecord {
  id: string;
  promptVersionId: string;
  approvedBy: string;
  approvalStatus: ApprovalStatus;
  approvedAt: Date | null;
}

function rowToApproval(r: Record<string, unknown>): ApprovalRecord {
  return {
    id: r["id"] as string,
    promptVersionId: r["prompt_version_id"] as string,
    approvedBy: r["approved_by"] as string,
    approvalStatus: r["approval_status"] as ApprovalStatus,
    approvedAt: r["approved_at"] ? new Date(r["approved_at"] as string) : null,
  };
}

// ─── createApproval ───────────────────────────────────────────────────────────
// INV-PG7: Requires a passed review. INV-PG8: Unique per version.
export async function createApproval(params: {
  promptVersionId: string;
  approvedBy: string;
  skipReviewCheck?: boolean;
}): Promise<ApprovalRecord> {
  const { promptVersionId, approvedBy, skipReviewCheck = false } = params;
  if (!promptVersionId || !approvedBy) throw new Error("INV-PG6: promptVersionId, approvedBy required");

  // INV-PG7: Verify review passed
  if (!skipReviewCheck) {
    const review = await getLatestReview(promptVersionId);
    if (!isReviewPassed(review)) {
      throw new Error(`INV-PG7: Cannot approve — latest review is '${review?.reviewStatus ?? "none"}' (must be 'approved')`);
    }
  }

  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.prompt_approvals (id,prompt_version_id,approved_by,approval_status,approved_at)
       VALUES (gen_random_uuid()::text,$1,$2,'approved',now())
       ON CONFLICT (prompt_version_id) DO UPDATE SET
         approved_by=EXCLUDED.approved_by,
         approval_status='approved',
         approved_at=now()
       RETURNING *`,
      [promptVersionId, approvedBy],
    );
    const approval = rowToApproval(r.rows[0]);

    // Audit log (fire-and-forget)
    logChange({ promptVersionId, changeType: "approved", changedBy: approvedBy, changeDescription: `Prompt version approved by ${approvedBy}` }).catch(() => {});

    return approval;
  } finally {
    await client.end();
  }
}

// ─── rejectApproval ───────────────────────────────────────────────────────────
export async function rejectApproval(params: { promptVersionId: string; rejectedBy: string; reason?: string }): Promise<ApprovalRecord> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.prompt_approvals (id,prompt_version_id,approved_by,approval_status)
       VALUES (gen_random_uuid()::text,$1,$2,'rejected')
       ON CONFLICT (prompt_version_id) DO UPDATE SET
         approved_by=EXCLUDED.approved_by, approval_status='rejected', approved_at=null
       RETURNING *`,
      [params.promptVersionId, params.rejectedBy],
    );
    logChange({ promptVersionId: params.promptVersionId, changeType: "rejected", changedBy: params.rejectedBy, changeDescription: params.reason ?? "Rejected" }).catch(() => {});
    return rowToApproval(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── revokeApproval ───────────────────────────────────────────────────────────
export async function revokeApproval(params: { promptVersionId: string; revokedBy: string; reason?: string }): Promise<ApprovalRecord> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `UPDATE public.prompt_approvals SET approval_status='revoked', approved_at=null
       WHERE prompt_version_id=$1 RETURNING *`,
      [params.promptVersionId],
    );
    if (!r.rows.length) throw new Error(`No approval found for version ${params.promptVersionId}`);
    logChange({ promptVersionId: params.promptVersionId, changeType: "revoked", changedBy: params.revokedBy, changeDescription: params.reason ?? "Revoked" }).catch(() => {});
    return rowToApproval(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── getApproval ─────────────────────────────────────────────────────────────
export async function getApproval(promptVersionId: string, client?: pg.Client): Promise<ApprovalRecord | null> {
  const useExt = !client;
  const c = client ?? getClient();
  if (useExt) await c.connect();
  try {
    const r = await c.query(`SELECT * FROM public.prompt_approvals WHERE prompt_version_id=$1`, [promptVersionId]);
    return r.rows.length ? rowToApproval(r.rows[0]) : null;
  } finally {
    if (useExt) await c.end();
  }
}

// ─── isVersionApproved ────────────────────────────────────────────────────────
// INV-PG6: Used to gate execution.
export async function isVersionApproved(promptVersionId: string): Promise<boolean> {
  const approval = await getApproval(promptVersionId);
  return approval?.approvalStatus === "approved";
}

// ─── assertVersionApproved ────────────────────────────────────────────────────
export async function assertVersionApproved(promptVersionId: string): Promise<void> {
  const approved = await isVersionApproved(promptVersionId);
  if (!approved) throw new Error(`INV-PG6: Prompt version '${promptVersionId}' is not approved for execution`);
}
