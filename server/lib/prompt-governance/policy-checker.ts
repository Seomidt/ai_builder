/**
 * Phase 13 — Policy Checker
 * Evaluates active policies and logs violations.
 * INV-PG11: All violations are logged before request is rejected.
 * INV-PG12: Policy check is applied before model execution.
 */

import pg from "pg";
import { listPolicies, evaluateAllPolicies, type PolicyRecord } from "./policy-engine.ts";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export interface ViolationRecord {
  id: string;
  requestId: string;
  policyId: string;
  violationType: string;
  createdAt: Date;
}

function rowToViolation(r: Record<string, unknown>): ViolationRecord {
  return {
    id: r["id"] as string,
    requestId: r["request_id"] as string,
    policyId: r["policy_id"] as string,
    violationType: r["violation_type"] as string,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── logViolation ─────────────────────────────────────────────────────────────
// INV-PG11: Log violation before blocking request.
export async function logViolation(params: {
  requestId: string;
  policyId: string;
  violationType: string;
  client?: pg.Client;
}): Promise<ViolationRecord> {
  const { requestId, policyId, violationType } = params;
  const useExt = !params.client;
  const client = params.client ?? getClient();
  if (useExt) await client.connect();

  try {
    const r = await client.query(
      `INSERT INTO public.prompt_policy_violations (id,request_id,policy_id,violation_type)
       VALUES (gen_random_uuid()::text,$1,$2,$3) RETURNING *`,
      [requestId, policyId, violationType],
    );
    return rowToViolation(r.rows[0]);
  } finally {
    if (useExt) await client.end();
  }
}

// ─── checkAndLogPolicies ──────────────────────────────────────────────────────
// INV-PG12: Full check pipeline — evaluate + log violations.
export async function checkAndLogPolicies(params: {
  tenantId: string;
  requestId: string;
  queryText: string;
  hasApproval?: boolean;
}): Promise<{ passed: boolean; violationCount: number; violations: ViolationRecord[] }> {
  const { tenantId, requestId, queryText, hasApproval = false } = params;

  const policies = await listPolicies({ tenantId, activeOnly: true });
  if (policies.length === 0) return { passed: true, violationCount: 0, violations: [] };

  const evalResult = evaluateAllPolicies({ policies, queryText, hasApproval });

  const violations: ViolationRecord[] = [];
  if (!evalResult.allPassed) {
    // INV-PG11: Log ALL violations before rejecting
    const client = getClient();
    await client.connect();
    try {
      for (const v of evalResult.violations) {
        const logged = await logViolation({
          requestId,
          policyId: v.policyId,
          violationType: v.violationType ?? "policy_violation",
          client,
        });
        violations.push(logged);
      }
    } finally {
      await client.end();
    }
  }

  return { passed: evalResult.allPassed, violationCount: violations.length, violations };
}

// ─── listViolations ───────────────────────────────────────────────────────────
export async function listViolations(params: {
  tenantId: string;
  requestId?: string;
  policyId?: string;
  limit?: number;
}): Promise<ViolationRecord[]> {
  const { tenantId, requestId, policyId, limit = 50 } = params;
  const client = getClient();
  await client.connect();

  try {
    const conds: string[] = [
      // Tenant scoping via join to policies
      `EXISTS (SELECT 1 FROM public.prompt_policies pp WHERE pp.id = prompt_policy_violations.policy_id AND pp.tenant_id = $1)`,
    ];
    const vals: unknown[] = [tenantId];

    if (requestId) { conds.push(`request_id=$${vals.length + 1}`); vals.push(requestId); }
    if (policyId) { conds.push(`policy_id=$${vals.length + 1}`); vals.push(policyId); }

    vals.push(Math.min(limit, 200));

    const r = await client.query(
      `SELECT * FROM public.prompt_policy_violations WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $${vals.length}`,
      vals,
    );
    return r.rows.map(rowToViolation);
  } finally {
    await client.end();
  }
}

// ─── getViolationsByPolicy ────────────────────────────────────────────────────
export async function getViolationsByPolicy(policyId: string): Promise<ViolationRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT * FROM public.prompt_policy_violations WHERE policy_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [policyId],
    );
    return r.rows.map(rowToViolation);
  } finally {
    await client.end();
  }
}
