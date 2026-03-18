/**
 * Phase 24 — Model Allowlist
 * Controls which AI models can be accessed on the platform and per-tenant.
 */

import { db } from "../../db";
import { modelAllowlists } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

// ── Seeded platform models ────────────────────────────────────────────────────

export const PLATFORM_APPROVED_MODELS = [
  { modelName: "gpt-4o",              provider: "openai",    active: true,  maxTokens: 128000, tier: "premium",    description: "GPT-4o flagship" },
  { modelName: "gpt-4o-mini",         provider: "openai",    active: true,  maxTokens: 128000, tier: "standard",   description: "GPT-4o mini" },
  { modelName: "gpt-4-turbo",         provider: "openai",    active: true,  maxTokens: 128000, tier: "premium",    description: "GPT-4 Turbo" },
  { modelName: "gpt-3.5-turbo",       provider: "openai",    active: true,  maxTokens: 16385,  tier: "standard",   description: "GPT-3.5 Turbo" },
  { modelName: "claude-3-5-sonnet",   provider: "anthropic", active: true,  maxTokens: 200000, tier: "premium",    description: "Claude 3.5 Sonnet" },
  { modelName: "claude-3-haiku",      provider: "anthropic", active: true,  maxTokens: 200000, tier: "standard",   description: "Claude 3 Haiku" },
  { modelName: "gemini-1.5-pro",      provider: "google",    active: true,  maxTokens: 1000000,tier: "premium",    description: "Gemini 1.5 Pro" },
  { modelName: "gemini-1.5-flash",    provider: "google",    active: true,  maxTokens: 1000000,tier: "standard",   description: "Gemini 1.5 Flash" },
  { modelName: "o1-preview",          provider: "openai",    active: true,  maxTokens: 128000, tier: "restricted", description: "OpenAI o1 preview" },
  { modelName: "o1-mini",             provider: "openai",    active: true,  maxTokens: 65536,  tier: "restricted", description: "OpenAI o1 mini" },
] as const;

export type ModelTier = "standard" | "premium" | "restricted";

// ── Model allowlist CRUD ──────────────────────────────────────────────────────

export async function seedModelAllowlist(): Promise<{ seeded: number }> {
  let seeded = 0;
  for (const model of PLATFORM_APPROVED_MODELS) {
    const existing = await db.execute(drizzleSql`
      SELECT id FROM model_allowlists WHERE model_name = ${model.modelName} LIMIT 1
    `);
    if (existing.rows.length === 0) {
      await db.insert(modelAllowlists).values(model);
      seeded++;
    }
  }
  return { seeded };
}

export async function getModel(modelName: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM model_allowlists WHERE model_name = ${modelName} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

export async function listModels(params?: { active?: boolean; tier?: string; provider?: string }): Promise<Array<Record<string, unknown>>> {
  const active = params?.active !== undefined ? drizzleSql`AND active = ${params.active}` : drizzleSql``;
  const tier = params?.tier ? drizzleSql`AND tier = ${params.tier}` : drizzleSql``;
  const provider = params?.provider ? drizzleSql`AND provider = ${params.provider}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT * FROM model_allowlists WHERE 1=1 ${active} ${tier} ${provider}
    ORDER BY provider ASC, model_name ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

export async function setModelActive(modelName: string, active: boolean): Promise<{ updated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE model_allowlists SET active = ${active} WHERE model_name = ${modelName}
  `);
  return { updated: true };
}

export async function addModel(params: {
  modelName: string;
  provider: string;
  maxTokens?: number;
  tier?: string;
  description?: string;
}): Promise<{ id: string }> {
  const rows = await db.insert(modelAllowlists).values({
    modelName: params.modelName,
    provider: params.provider,
    active: true,
    maxTokens: params.maxTokens ?? 4096,
    tier: (params.tier as ModelTier) ?? "standard",
    description: params.description ?? null,
  }).returning({ id: modelAllowlists.id });
  return { id: rows[0].id };
}

// ── Model access checks ───────────────────────────────────────────────────────

/**
 * Check if a model is on the platform-wide allowlist.
 */
export async function isModelAllowed(modelName: string): Promise<{
  allowed: boolean;
  reason?: string;
  model?: Record<string, unknown>;
}> {
  const model = await getModel(modelName);
  if (!model) {
    return { allowed: false, reason: `Model "${modelName}" is not in the platform allowlist` };
  }
  if (!model.active) {
    return { allowed: false, reason: `Model "${modelName}" is currently deactivated`, model };
  }
  return { allowed: true, model };
}

/**
 * Check if a model is allowed for a specific tenant (cross-references tenant settings).
 */
export function isTenantModelAllowed(modelName: string, allowedModels: string[]): {
  allowed: boolean;
  reason?: string;
} {
  if (!allowedModels || allowedModels.length === 0) {
    // No restriction — all platform models allowed
    return { allowed: true };
  }
  if (allowedModels.includes(modelName)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Model "${modelName}" is not in the tenant's allowed model list`,
  };
}

/**
 * Full model access check: platform allowlist + tenant allowlist.
 */
export async function checkModelAccess(params: {
  modelName: string;
  tenantAllowedModels?: string[];
}): Promise<{ allowed: boolean; reason?: string }> {
  const platformCheck = await isModelAllowed(params.modelName);
  if (!platformCheck.allowed) return { allowed: false, reason: platformCheck.reason };

  const tenantCheck = isTenantModelAllowed(params.modelName, params.tenantAllowedModels ?? []);
  if (!tenantCheck.allowed) return { allowed: false, reason: tenantCheck.reason };

  return { allowed: true };
}

/**
 * Get model usage distribution from moderation events.
 */
export async function getModelUsageDistribution(tenantId?: string): Promise<Array<{
  modelName: string;
  requestCount: number;
  blockedCount: number;
}>> {
  const tenantClause = tenantId ? drizzleSql`AND tenant_id = ${tenantId}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT
      model_name,
      COUNT(*) AS request_count,
      COUNT(*) FILTER (WHERE result = 'blocked') AS blocked_count
    FROM moderation_events
    WHERE model_name IS NOT NULL ${tenantClause}
    GROUP BY model_name ORDER BY request_count DESC
  `);
  return rows.rows.map(r => ({
    modelName: (r as Record<string, unknown>).model_name as string,
    requestCount: Number((r as Record<string, unknown>).request_count),
    blockedCount: Number((r as Record<string, unknown>).blocked_count),
  }));
}
