/**
 * Phase 13 — Policy Engine
 * Creates, reads, and evaluates prompt policies for a tenant.
 * INV-PG1: Policies are tenant-scoped.
 * INV-PG2: Inactive policies are never applied.
 * INV-PG3: Policy evaluation is read-only — violations logged separately.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export type PolicyType = "content_safety" | "injection_prevention" | "topic_restriction" | "output_format" | "approval_required" | "rate_limit";

export interface PolicyRecord {
  id: string;
  tenantId: string;
  policyName: string;
  policyType: PolicyType;
  policyRules: Record<string, unknown>;
  isActive: boolean;
  createdAt: Date;
}

export interface PolicyEvalResult {
  passed: boolean;
  policyId: string;
  policyName: string;
  policyType: PolicyType;
  violationType?: string;
  detail?: string;
}

function rowToPolicy(r: Record<string, unknown>): PolicyRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    policyName: r["policy_name"] as string,
    policyType: r["policy_type"] as PolicyType,
    policyRules: (r["policy_rules"] as Record<string, unknown>) ?? {},
    isActive: r["is_active"] as boolean,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── createPolicy ─────────────────────────────────────────────────────────────
export async function createPolicy(params: {
  tenantId: string;
  policyName: string;
  policyType: PolicyType;
  policyRules?: Record<string, unknown>;
}): Promise<PolicyRecord> {
  const { tenantId, policyName, policyType, policyRules = {} } = params;
  if (!tenantId || !policyName) throw new Error("INV-PG1: tenantId, policyName required");

  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.prompt_policies (id,tenant_id,policy_name,policy_type,policy_rules)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4) RETURNING *`,
      [tenantId, policyName, policyType, JSON.stringify(policyRules)],
    );
    return rowToPolicy(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── listPolicies ─────────────────────────────────────────────────────────────
export async function listPolicies(params: { tenantId: string; activeOnly?: boolean }): Promise<PolicyRecord[]> {
  const { tenantId, activeOnly = false } = params;
  const client = getClient();
  await client.connect();
  try {
    const cond = activeOnly ? "AND is_active = true" : "";
    const r = await client.query(
      `SELECT * FROM public.prompt_policies WHERE tenant_id=$1 ${cond} ORDER BY created_at DESC`,
      [tenantId],
    );
    return r.rows.map(rowToPolicy);
  } finally {
    await client.end();
  }
}

// ─── deactivatePolicy ─────────────────────────────────────────────────────────
export async function deactivatePolicy(policyId: string, tenantId: string): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    await client.query(`UPDATE public.prompt_policies SET is_active=false WHERE id=$1 AND tenant_id=$2`, [policyId, tenantId]);
  } finally {
    await client.end();
  }
}

// ─── evaluateContentSafety ────────────────────────────────────────────────────
function evaluateContentSafety(queryText: string, rules: Record<string, unknown>): boolean {
  const forbiddenTopics = (rules["forbidden_topics"] as string[]) ?? [];
  return !forbiddenTopics.some((topic) => queryText.toLowerCase().includes(topic.toLowerCase()));
}

// ─── evaluateInjectionPrevention ──────────────────────────────────────────────
function evaluateInjectionPrevention(queryText: string): boolean {
  const dangerousPatterns = [
    /ignore\s+(all\s+)?previous/i,
    /override\s+system/i,
    /\[SYSTEM\]/i,
    /jailbreak/i,
    /DAN\s+mode/i,
  ];
  return !dangerousPatterns.some((p) => p.test(queryText));
}

// ─── evaluateTopicRestriction ─────────────────────────────────────────────────
function evaluateTopicRestriction(queryText: string, rules: Record<string, unknown>): boolean {
  const allowedTopics = (rules["allowed_topics"] as string[]) ?? [];
  if (allowedTopics.length === 0) return true;
  return allowedTopics.some((topic) => queryText.toLowerCase().includes(topic.toLowerCase()));
}

// ─── evaluatePolicy ───────────────────────────────────────────────────────────
// INV-PG3: Read-only evaluation.
export function evaluatePolicy(params: { policy: PolicyRecord; queryText: string; hasApproval?: boolean }): PolicyEvalResult {
  const { policy, queryText, hasApproval = false } = params;

  // INV-PG2: Skip inactive policies
  if (!policy.isActive) {
    return { passed: true, policyId: policy.id, policyName: policy.policyName, policyType: policy.policyType };
  }

  let passed = true;
  let violationType: string | undefined;
  let detail: string | undefined;

  switch (policy.policyType) {
    case "content_safety":
      passed = evaluateContentSafety(queryText, policy.policyRules);
      if (!passed) { violationType = "content_safety"; detail = "Query contains forbidden topic"; }
      break;
    case "injection_prevention":
      passed = evaluateInjectionPrevention(queryText);
      if (!passed) { violationType = "injection_attempt"; detail = "Injection pattern detected"; }
      break;
    case "topic_restriction":
      passed = evaluateTopicRestriction(queryText, policy.policyRules);
      if (!passed) { violationType = "topic_violation"; detail = "Query outside allowed topics"; }
      break;
    case "approval_required":
      passed = hasApproval;
      if (!passed) { violationType = "approval_bypass"; detail = "Prompt version not approved"; }
      break;
    case "output_format":
      passed = true; // Output format checked post-execution
      break;
    case "rate_limit":
      passed = true; // Rate limiting handled by orchestrator
      break;
  }

  return { passed, policyId: policy.id, policyName: policy.policyName, policyType: policy.policyType, violationType, detail };
}

// ─── evaluateAllPolicies ──────────────────────────────────────────────────────
export function evaluateAllPolicies(params: {
  policies: PolicyRecord[];
  queryText: string;
  hasApproval?: boolean;
}): { allPassed: boolean; results: PolicyEvalResult[]; violations: PolicyEvalResult[] } {
  const results = params.policies.map((p) =>
    evaluatePolicy({ policy: p, queryText: params.queryText, hasApproval: params.hasApproval }),
  );
  const violations = results.filter((r) => !r.passed);
  return { allPassed: violations.length === 0, results, violations };
}

// ─── getPolicyById ────────────────────────────────────────────────────────────
export async function getPolicyById(policyId: string, tenantId: string): Promise<PolicyRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(`SELECT * FROM public.prompt_policies WHERE id=$1 AND tenant_id=$2`, [policyId, tenantId]);
    return r.rows.length ? rowToPolicy(r.rows[0]) : null;
  } finally {
    await client.end();
  }
}
