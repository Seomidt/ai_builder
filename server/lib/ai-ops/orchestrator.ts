// ─── Phase 51: AI Ops Assistant — Orchestrator ────────────────────────────────
//
// Validates intent → validates access → assembles safe context → calls AI →
// validates output contract → returns structured ops response.
//
// The model has NO direct DB access. Context is always pre-assembled.
// No prompt injection surface from tenant content.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from "openai";
import { env } from "../env";
import { assertValidIntent, getIntentDefinition, OPS_INTENT, type OpsIntentId } from "./intents";
import { assertAiOpsAccess, resolveAiOpsScope, type AiOpsAccessContext, type AiOpsScope } from "./access-control";
import {
  buildPlatformHealthContext,
  buildTenantUsageContext,
  buildAiCostContext,
  buildAnomalyContext,
  buildRetentionContext,
  buildBillingHealthContext,
  buildStorageHealthContext,
  buildSecurityContext,
  type PlatformHealthContext,
  type TenantUsageContext,
  type AiCostContext,
  type AnomalyContext,
  type BillingHealthContext,
  type RetentionContext,
  type StorageHealthContext,
  type SecurityContext,
} from "./context-assembler";
import { validateOpsResponse, makeBaseResponse, type OpsResponseBase } from "./response-contracts";
import { assertAiOpsSafeContext, assertAiOpsOutputSafe, assertNoForbiddenIntent, assertNoRawTenantContent } from "./safety";
import { logAiOpsAudit } from "./audit";
import type { AiOpsSourceId } from "./data-sources";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export interface OrchestratorInput {
  intent: string;
  accessCtx: AiOpsAccessContext;
  tenantId?: string;
  dateRange?: { from: string; to: string };
}

export interface OrchestratorResult {
  success: boolean;
  response?: OpsResponseBase;
  error?: string;
  auditId: string;
}

const SYSTEM_PROMPT = `You are an internal AI Ops Assistant for a multi-tenant SaaS platform.

Rules you MUST follow:
1. Only analyze the structured context provided. Do not invent data not in context.
2. Do not suggest autonomous actions — advisory only.
3. Respond ONLY in valid JSON matching the schema described.
4. Keep "summary" under 500 characters.
5. findings[] max 6 items. risks[] max 4. recommendedActions[] max 4.
6. confidence must be "high", "medium", "low", or "insufficient_data".
7. Never reference raw prompts, user content, or PII.
8. If data is insufficient, set confidence to "insufficient_data".`;

function buildUserPrompt(intent: OpsIntentId, scope: AiOpsScope, context: unknown): string {
  const intentDef = getIntentDefinition(intent);
  return `Intent: ${intentDef.displayName}
Scope: ${scope.mode}${scope.organizationId ? ` (org: ${scope.organizationId})` : ""}

Structured operational context (JSON):
${JSON.stringify(context, null, 2)}

Produce a JSON object with these fields:
- summary (string, max 500 chars, operational tone)
- findings (array of {area, observation, severity: "info"|"warning"|"critical"|"ok", metric?, value?})
- risks (array of {risk, likelihood: "low"|"medium"|"high", impact: "low"|"medium"|"high", mitigation?})
- recommendedActions (array of {action, priority: "low"|"medium"|"high"|"critical", owner?, rationale})
- confidence ("high"|"medium"|"low"|"insufficient_data")
- [intent-specific fields as required]

Stay grounded. Only reference what is in the context above.`;
}

function injectIntentDefaults(
  intent: OpsIntentId,
  context: unknown,
  scope: AiOpsScope,
  enriched: Record<string, unknown>,
): void {
  switch (intent) {
    case OPS_INTENT.PLATFORM_HEALTH_SUMMARY: {
      const ctx = context as PlatformHealthContext;
      if (enriched.activeAnomalies === undefined) enriched.activeAnomalies = ctx.recentAnomalyCount ?? 0;
      if (enriched.systemStatus === undefined) enriched.systemStatus = ctx.systemStatus ?? "unknown";
      break;
    }
    case OPS_INTENT.TENANT_USAGE_SUMMARY: {
      const ctx = context as TenantUsageContext;
      if (enriched.tenantId === undefined) enriched.tenantId = ctx.tenantId ?? scope.tenantId ?? "";
      if (enriched.tokensConsumedTotal === undefined) {
        enriched.tokensConsumedTotal = ctx.recentSnapshots?.reduce(
          (s, r) => s + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0
        ) ?? 0;
      }
      if (enriched.estimatedCostUsd === undefined) {
        enriched.estimatedCostUsd = ctx.recentSnapshots?.reduce(
          (s, r) => s + parseFloat(r.costUsd ?? "0"), 0
        ) ?? 0;
      }
      break;
    }
    case OPS_INTENT.AI_COST_SUMMARY: {
      const ctx = context as AiCostContext;
      if (enriched.totalCostUsd === undefined) enriched.totalCostUsd = ctx.totalSnapshotCostUsd ?? 0;
      if (enriched.activeAlerts === undefined) enriched.activeAlerts = ctx.recentAlerts?.length ?? 0;
      if (enriched.tenantsOverBudget === undefined) enriched.tenantsOverBudget = ctx.recentAlerts?.length ?? 0;
      if (enriched.topCostDrivers === undefined) enriched.topCostDrivers = [];
      break;
    }
    case OPS_INTENT.ANOMALY_EXPLANATION: {
      const ctx = context as AnomalyContext;
      if (enriched.anomalyCount === undefined) enriched.anomalyCount = ctx.anomalies?.length ?? 0;
      if (enriched.mostRecentAnomalyAt === undefined) {
        enriched.mostRecentAnomalyAt = ctx.anomalies?.[0]?.createdAt ?? null;
      }
      if (enriched.anomalyTypes === undefined) {
        enriched.anomalyTypes = [...new Set(ctx.anomalies?.map((a) => a.eventType) ?? [])];
      }
      break;
    }
    case OPS_INTENT.BILLING_HEALTH_SUMMARY: {
      const ctx = context as BillingHealthContext;
      if (enriched.activeSubscriptions === undefined) {
        enriched.activeSubscriptions = ctx.subscriptionStatusCounts?.["active"] ?? 0;
      }
      if (enriched.pastDueSubscriptions === undefined) {
        enriched.pastDueSubscriptions = ctx.subscriptionStatusCounts?.["past_due"] ?? 0;
      }
      if (enriched.overdueInvoices === undefined) enriched.overdueInvoices = ctx.overdueCount ?? 0;
      if (enriched.totalDueUsd === undefined) enriched.totalDueUsd = 0;
      break;
    }
    case OPS_INTENT.RETENTION_SUMMARY: {
      const ctx = context as RetentionContext;
      if (enriched.activeUsersLast7d === undefined) enriched.activeUsersLast7d = ctx.retentionEvents ?? 0;
      if (enriched.activeUsersLast30d === undefined) enriched.activeUsersLast30d = ctx.productEvents ?? 0;
      if (enriched.churnSignals === undefined) enriched.churnSignals = [];
      break;
    }
    case OPS_INTENT.SUPPORT_DEBUG_SUMMARY: {
      if (enriched.tenantId === undefined) enriched.tenantId = scope.tenantId ?? "";
      if (enriched.recentAlertCount === undefined) enriched.recentAlertCount = 0;
      if (enriched.recentAnomalyCount === undefined) enriched.recentAnomalyCount = 0;
      if (enriched.debugSignals === undefined) enriched.debugSignals = [];
      break;
    }
    case OPS_INTENT.SECURITY_SUMMARY: {
      const ctx = context as SecurityContext;
      if (enriched.totalSecurityEvents === undefined) enriched.totalSecurityEvents = ctx.totalEvents ?? 0;
      if (enriched.criticalEventCount === undefined) enriched.criticalEventCount = ctx.criticalCount ?? 0;
      if (enriched.eventsByType === undefined) enriched.eventsByType = ctx.eventTypeCounts ?? {};
      break;
    }
    case OPS_INTENT.STORAGE_HEALTH_SUMMARY: {
      const ctx = context as StorageHealthContext;
      if (enriched.totalFiles === undefined) enriched.totalFiles = ctx.totalFiles ?? 0;
      if (enriched.totalBytes === undefined) enriched.totalBytes = ctx.totalBytes ?? 0;
      if (enriched.orgCount === undefined) enriched.orgCount = ctx.orgCount ?? 0;
      break;
    }
    case OPS_INTENT.WEEKLY_OPS_DIGEST: {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86400_000);
      if (enriched.weekStart === undefined) enriched.weekStart = weekAgo.toISOString().split("T")[0];
      if (enriched.weekEnd === undefined) enriched.weekEnd = now.toISOString().split("T")[0];
      if (enriched.highlights === undefined) enriched.highlights = [];
      if (enriched.newAnomalies === undefined) enriched.newAnomalies = 0;
      if (enriched.billingIssues === undefined) enriched.billingIssues = 0;
      break;
    }
    default:
      break;
  }
}

async function assembleContext(intent: OpsIntentId, scope: AiOpsScope): Promise<{ context: unknown; sourceIds: AiOpsSourceId[] }> {
  const tenantId = scope.tenantId;

  switch (intent) {
    case OPS_INTENT.PLATFORM_HEALTH_SUMMARY: {
      const ctx = await buildPlatformHealthContext();
      return { context: ctx, sourceIds: ctx.meta.sourceIds as AiOpsSourceId[] };
    }
    case OPS_INTENT.TENANT_USAGE_SUMMARY: {
      if (!tenantId) throw new Error("tenantId required for tenant_usage_summary");
      const ctx = await buildTenantUsageContext(tenantId);
      return { context: ctx, sourceIds: ctx.meta.sourceIds as AiOpsSourceId[] };
    }
    case OPS_INTENT.AI_COST_SUMMARY: {
      const ctx = await buildAiCostContext(tenantId);
      return { context: ctx, sourceIds: ctx.meta.sourceIds as AiOpsSourceId[] };
    }
    case OPS_INTENT.ANOMALY_EXPLANATION: {
      const ctx = await buildAnomalyContext(tenantId);
      return { context: ctx, sourceIds: ctx.meta.sourceIds as AiOpsSourceId[] };
    }
    case OPS_INTENT.BILLING_HEALTH_SUMMARY: {
      const ctx = await buildBillingHealthContext();
      return { context: ctx, sourceIds: ctx.meta.sourceIds as AiOpsSourceId[] };
    }
    case OPS_INTENT.RETENTION_SUMMARY: {
      const ctx = await buildRetentionContext();
      return { context: ctx, sourceIds: ctx.meta.sourceIds as AiOpsSourceId[] };
    }
    case OPS_INTENT.SUPPORT_DEBUG_SUMMARY: {
      if (!tenantId) throw new Error("tenantId required for support_debug_summary");
      const [cost, anomaly] = await Promise.all([
        buildAiCostContext(tenantId),
        buildAnomalyContext(tenantId),
      ]);
      const ctx = { cost, anomaly, meta: cost.meta };
      return { context: ctx, sourceIds: [...cost.meta.sourceIds, ...anomaly.meta.sourceIds] as AiOpsSourceId[] };
    }
    case OPS_INTENT.SECURITY_SUMMARY: {
      const ctx = await buildSecurityContext();
      return { context: ctx, sourceIds: ctx.meta.sourceIds as AiOpsSourceId[] };
    }
    case OPS_INTENT.STORAGE_HEALTH_SUMMARY: {
      const ctx = await buildStorageHealthContext(tenantId);
      return { context: ctx, sourceIds: ctx.meta.sourceIds as AiOpsSourceId[] };
    }
    case OPS_INTENT.WEEKLY_OPS_DIGEST: {
      const [health, cost, billing, retention, security] = await Promise.all([
        buildPlatformHealthContext(),
        buildAiCostContext(),
        buildBillingHealthContext(),
        buildRetentionContext(),
        buildSecurityContext(),
      ]);
      const ctx = { health, cost, billing, retention, security };
      const allSourceIds = [
        ...health.meta.sourceIds,
        ...cost.meta.sourceIds,
        ...billing.meta.sourceIds,
        ...retention.meta.sourceIds,
        ...security.meta.sourceIds,
      ] as AiOpsSourceId[];
      return { context: ctx, sourceIds: allSourceIds };
    }
    default:
      throw new Error(`No context assembler for intent: ${intent}`);
  }
}

export async function runAiOpsQuery(input: OrchestratorInput): Promise<OrchestratorResult> {
  const auditId = `aiops_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    assertNoForbiddenIntent(input.intent);
    assertValidIntent(input.intent);
    assertAiOpsAccess(input.accessCtx);

    const scope = resolveAiOpsScope(input.accessCtx);
    const intentId = input.intent as OpsIntentId;
    const intentDef = getIntentDefinition(intentId);

    const { context, sourceIds } = await assembleContext(intentId, scope);

    assertNoRawTenantContent(context as Record<string, unknown>);
    assertAiOpsSafeContext(context as Record<string, unknown>, sourceIds);

    const userPrompt = buildUserPrompt(intentId, scope, context);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const rawOutput = completion.choices[0]?.message?.content ?? "{}";
    assertAiOpsOutputSafe(rawOutput);

    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    const base = makeBaseResponse(intentId, scope.mode, scope.organizationId ?? null, sourceIds);

    const enriched: Record<string, unknown> = {
      ...base,
      ...parsed,
      intent: intentId,
      scope: scope.mode,
      organizationId: scope.organizationId ?? null,
      sourcesUsed: sourceIds,
      dataFreshness: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
    };

    injectIntentDefaults(intentId, context, scope, enriched);

    const validated = validateOpsResponse(intentId, enriched);

    await logAiOpsAudit({
      auditId,
      userId: input.accessCtx.user.userId,
      intent: intentId,
      scope: scope.mode,
      organizationId: scope.organizationId,
      success: true,
    });

    return { success: true, response: validated, auditId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    await logAiOpsAudit({
      auditId,
      userId: input.accessCtx.user.userId,
      intent: input.intent,
      scope: "platform",
      organizationId: undefined,
      success: false,
      errorMessage: message,
    }).catch(() => {});

    return { success: false, error: message, auditId };
  }
}
