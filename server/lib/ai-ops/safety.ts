// ─── Phase 51: AI Ops Assistant — Safety Guards ───────────────────────────────
//
// Safeguards that prevent unsafe model behavior:
// - No unsupported intent
// - No raw tenant content in context
// - No secrets/tokens in context
// - No cross-tenant aggregation in tenant mode
// - No "take action" outputs
// - No fabricated certainty
// ─────────────────────────────────────────────────────────────────────────────

import { FORBIDDEN_SOURCE_CATEGORIES, type AiOpsSourceId, AI_OPS_DATA_SOURCES } from "./data-sources";
import { isValidIntent, type OpsIntentId } from "./intents";

export class AiOpsSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOpsSafetyError";
  }
}

const FORBIDDEN_CONTEXT_FIELDS = new Set([
  "password",
  "secret",
  "token",
  "api_key",
  "apiKey",
  "private_key",
  "privateKey",
  "signed_url",
  "signedUrl",
  "r2_key",
  "r2Key",
  "stripe_customer_id",
  "stripeCustomerId",
  "stripe_subscription_id",
  "stripeSubscriptionId",
  "stripe_invoice_id",
  "stripeInvoiceId",
  "hosted_invoice_url",
  "hostedInvoiceUrl",
  "actor_user_id",
  "actorUserId",
  "ip_address",
  "ipAddress",
  "user_agent",
  "userAgent",
  "raw_payload",
  "rawPayload",
  "idempotency_key",
  "idempotencyKey",
  "session_id",
  "sessionId",
  "client_id",
  "clientId",
]);

const FORBIDDEN_OUTPUT_PATTERNS = [
  /will\s+now\s+(delete|drop|remove|execute|run|create|update)/i,
  /i\s+have\s+(deleted|removed|created|updated|executed)/i,
  /action\s+taken/i,
  /i\s+am\s+confident\s+that/i,
  /definitely\s+(is|are|will|has)/i,
  /guaranteed\s+to/i,
];

export interface SafeContextCheckResult {
  safe: boolean;
  violations: string[];
}

export function assertAiOpsSafeContext(
  context: Record<string, unknown>,
  sourceIds: AiOpsSourceId[],
): void {
  const result = checkContextSafety(context, sourceIds);
  if (!result.safe) {
    throw new AiOpsSafetyError(
      `Unsafe context detected. Violations:\n${result.violations.map((v) => `  - ${v}`).join("\n")}`,
    );
  }
}

export function checkContextSafety(
  context: Record<string, unknown>,
  sourceIds: AiOpsSourceId[],
): SafeContextCheckResult {
  const violations: string[] = [];

  for (const sourceId of sourceIds) {
    if (!(sourceId in AI_OPS_DATA_SOURCES)) {
      violations.push(`Forbidden source: "${sourceId}" is not in the allowed source registry.`);
    }
  }

  const contextStr = JSON.stringify(context);

  for (const field of FORBIDDEN_CONTEXT_FIELDS) {
    const fieldPattern = new RegExp(`["']${field}["']\\s*:`, "i");
    if (fieldPattern.test(contextStr)) {
      violations.push(`Forbidden field "${field}" found in context.`);
    }
  }

  for (const cat of FORBIDDEN_SOURCE_CATEGORIES) {
    if (contextStr.toLowerCase().includes(cat.toLowerCase().replace(/_/g, " "))) {
      violations.push(`Forbidden category reference "${cat}" found in context.`);
    }
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}

export function assertAiOpsOutputSafe(output: string): void {
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(output)) {
      throw new AiOpsSafetyError(
        `Unsafe output pattern detected. The assistant must not imply autonomous actions or fabricate certainty. ` +
          `Pattern: ${pattern.toString()}`,
      );
    }
  }
}

export function redactUnsafeOpsContext<T extends Record<string, unknown>>(obj: T): T {
  if (typeof obj !== "object" || obj === null) return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_CONTEXT_FIELDS.has(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactUnsafeOpsContext(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null
          ? redactUnsafeOpsContext(item as Record<string, unknown>)
          : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export function assertNoForbiddenIntent(intent: string): asserts intent is OpsIntentId {
  if (!isValidIntent(intent)) {
    throw new AiOpsSafetyError(
      `Forbidden intent: "${intent}" is not in the supported intent registry.`,
    );
  }
}

export function assertNoRawTenantContent(context: Record<string, unknown>): void {
  const dangerousKeys = ["raw_prompt", "rawPrompt", "model_output", "modelOutput", "checkin_text", "checkinText", "document_content", "documentContent"];
  for (const key of dangerousKeys) {
    if (key in context) {
      throw new AiOpsSafetyError(
        `Raw tenant content field "${key}" must not be included in AI Ops context.`,
      );
    }
  }
}

export const AI_OPS_SAFETY_CONFIG = {
  forbiddenContextFields: [...FORBIDDEN_CONTEXT_FIELDS],
  forbiddenSourceCategories: [...FORBIDDEN_SOURCE_CATEGORIES],
  forbiddenOutputPatternCount: FORBIDDEN_OUTPUT_PATTERNS.length,
  version: "phase51",
};
