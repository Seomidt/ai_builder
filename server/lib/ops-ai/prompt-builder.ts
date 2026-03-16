/**
 * Phase 33 — Ops AI Prompt Builder
 *
 * TASK 7: Sealed system prompt for ops assistant.
 * - May summarise only provided telemetry
 * - May not invent causes
 * - Must distinguish facts from inference
 * - Must clearly state uncertainty
 * - Must never suggest destructive actions without evidence
 * - Must not expose secrets or hidden internal credentials
 *
 * Prompt inputs are bounded and sanitised before use.
 */

// ── System prompt (sealed) ────────────────────────────────────────────────────

export const OPS_SYSTEM_PROMPT = `
You are an internal AI operations assistant for a multi-tenant AI software platform.
Your role is ADVISORY ONLY. You NEVER execute actions, mutations, or recovery operations.

STRICT RULES:
1. You may ONLY summarise and interpret the telemetry data provided in the user message.
2. You MUST NOT invent causes, metrics, or events that are not in the provided data.
3. You MUST distinguish between facts (directly in the data) and inferences (your interpretation).
4. When data is insufficient to make a determination, you MUST state this clearly in "unknowns".
5. You MUST NEVER suggest destructive, irreversible, or security-sensitive actions without direct evidence.
6. You MUST NOT expose secrets, API keys, tokens, credentials, or internal system details.
7. You MUST assign a confidence level ("low" | "medium" | "high") to every issue and correlation.
8. You MUST always respond with valid JSON conforming exactly to this schema — no extra text:

{
  "overall_health": "good" | "warning" | "critical",
  "summary": "2-4 sentence platform health overview",
  "top_issues": [
    {
      "title": "Brief issue title",
      "severity": "low" | "medium" | "high" | "critical",
      "evidence": ["specific metric or fact from the data"],
      "confidence": "low" | "medium" | "high"
    }
  ],
  "suspected_correlations": [
    {
      "title": "Brief correlation title",
      "reasoning": "Explanation referencing specific data points",
      "confidence": "low" | "medium" | "high"
    }
  ],
  "recommended_actions": [
    {
      "action": "Specific investigation or monitoring step (NOT a system mutation)",
      "reason": "Why this action is appropriate given the data",
      "priority": 1 | 2 | 3
    }
  ],
  "unknowns": ["Things that cannot be determined from the available data"]
}

If data is healthy with no issues, return top_issues: [], suspected_correlations: [], and summarise the healthy state.
Priority 1 = most urgent, 3 = least urgent.
`.trim();

// ── Telemetry section builders ────────────────────────────────────────────────

export interface TelemetryInput {
  systemHealth?:    Record<string, unknown> | null;
  jobSummary?:      Record<string, unknown> | null;
  failedJobs?:      unknown[] | null;
  webhookHealth?:   Record<string, unknown> | null;
  webhookFailures?: unknown[] | null;
  securitySnapshot?: Record<string, unknown> | null;
  securitySummary?: Record<string, unknown> | null;
  aiGovernance?:    Record<string, unknown> | null;
  billingHealth?:   Record<string, unknown> | null;
  incidentContext?: Record<string, unknown> | null;
}

/**
 * Bound the size of a value for inclusion in prompts.
 * Arrays are truncated to 10 items; strings to 400 chars.
 */
function bound(v: unknown): unknown {
  if (Array.isArray(v))       return v.slice(0, 10);
  if (typeof v === "string")  return v.slice(0, 400);
  return v;
}

function boundObject(obj: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = bound(v);
  }
  return out;
}

/**
 * Build a sanitised, bounded user-message from platform telemetry.
 * Removes any field that looks like a secret.
 */
const SECRET_PATTERN = /api_?key|secret|token|password|credential|authorization|private_?key/i;

function sanitiseKey(k: string): boolean {
  return !SECRET_PATTERN.test(k);
}

function sanitiseObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!sanitiseKey(k)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitiseObject(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function buildHealthSummaryPrompt(telemetry: TelemetryInput): string {
  const sections: Record<string, unknown> = {};

  if (telemetry.systemHealth)    sections.systemHealth    = sanitiseObject(boundObject(telemetry.systemHealth));
  if (telemetry.jobSummary)      sections.jobSummary      = sanitiseObject(boundObject(telemetry.jobSummary));
  if (telemetry.failedJobs)      sections.failedJobs      = (telemetry.failedJobs ?? []).slice(0, 5);
  if (telemetry.webhookHealth)   sections.webhookHealth   = sanitiseObject(boundObject(telemetry.webhookHealth));
  if (telemetry.webhookFailures) sections.webhookFailures = (telemetry.webhookFailures ?? []).slice(0, 5);
  if (telemetry.securitySnapshot) sections.securitySnapshot = sanitiseObject(boundObject(telemetry.securitySnapshot));
  if (telemetry.aiGovernance)    sections.aiGovernance    = sanitiseObject(boundObject(telemetry.aiGovernance));
  if (telemetry.billingHealth)   sections.billingHealth   = sanitiseObject(boundObject(telemetry.billingHealth));

  return `PLATFORM TELEMETRY (${new Date().toISOString()}):\n${JSON.stringify(sections, null, 2)}\n\nProvide a platform health summary per the JSON schema.`;
}

export function buildIncidentPrompt(
  incidentType: string,
  telemetry: TelemetryInput,
): string {
  const ctx = telemetry.incidentContext
    ? sanitiseObject(boundObject(telemetry.incidentContext))
    : {};

  const sections: Record<string, unknown> = {
    incidentType,
    context: ctx,
  };

  if (telemetry.jobSummary)      sections.jobSummary      = sanitiseObject(boundObject(telemetry.jobSummary));
  if (telemetry.failedJobs)      sections.failedJobs      = (telemetry.failedJobs ?? []).slice(0, 8);
  if (telemetry.webhookHealth)   sections.webhookHealth   = sanitiseObject(boundObject(telemetry.webhookHealth));
  if (telemetry.webhookFailures) sections.webhookFailures = (telemetry.webhookFailures ?? []).slice(0, 8);
  if (telemetry.securitySnapshot) sections.securitySnapshot = sanitiseObject(boundObject(telemetry.securitySnapshot));
  if (telemetry.aiGovernance)    sections.aiGovernance    = sanitiseObject(boundObject(telemetry.aiGovernance));
  if (telemetry.billingHealth)   sections.billingHealth   = sanitiseObject(boundObject(telemetry.billingHealth));

  return `INCIDENT ANALYSIS REQUEST:\nIncident type: ${incidentType}\n\nPLATFORM TELEMETRY:\n${JSON.stringify(sections, null, 2)}\n\nExplain this incident per the JSON schema.`;
}
