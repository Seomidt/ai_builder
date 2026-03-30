/**
 * Phase 18 — Runtime Resolution Helpers
 * Integrates flag resolution into existing runtime decision points.
 *
 * INV-FLAG9: Existing healthy default runtime flows must remain intact when no flag applies.
 * INV-FLAG2: Resolution is deterministic.
 * INV-FLAG8: No hidden writes in read-only/preview paths.
 */

import { resolveFeatureFlag } from "./variant-resolution.ts";

export interface RuntimeContext {
  tenantId?: string;
  actorId?: string;
  requestId?: string;
}

/**
 * Resolve model override for a given request context.
 * Returns null if no flag applies (INV-FLAG9: default flow remains intact).
 */
export async function resolveModelOverride(ctx: RuntimeContext): Promise<string | null> {
  try {
    const result = await resolveFeatureFlag("model.override", ctx, { writeEvent: true });
    if (result.resolutionSource === "default" && !result.resolvedConfig) return null;
    return (result.resolvedConfig?.modelName as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve prompt version override.
 * Returns null if no flag applies.
 */
export async function resolvePromptVersionOverride(ctx: RuntimeContext): Promise<string | null> {
  try {
    const result = await resolveFeatureFlag("prompt.version.override", ctx, { writeEvent: true });
    if (result.resolutionSource === "default" && !result.resolvedConfig) return null;
    return (result.resolvedConfig?.promptVersionId as string) ?? result.resolvedVariant ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve retrieval strategy override.
 * Returns null if no flag applies, preserving existing retrieval engine logic.
 */
export async function resolveRetrievalStrategyOverride(ctx: RuntimeContext): Promise<string | null> {
  try {
    const result = await resolveFeatureFlag("retrieval.strategy.override", ctx, { writeEvent: true });
    if (result.resolutionSource === "default" && !result.resolvedConfig && !result.resolvedVariant) return null;
    return (result.resolvedConfig?.strategy as string) ?? result.resolvedVariant ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve agent version override.
 * Returns null if no flag applies, preserving existing agent execution config.
 */
export async function resolveAgentVersionOverride(ctx: RuntimeContext): Promise<string | null> {
  try {
    const result = await resolveFeatureFlag("agent.version.override", ctx, { writeEvent: true });
    if (result.resolutionSource === "default" && !result.resolvedConfig && !result.resolvedVariant) return null;
    return (result.resolvedConfig?.agentVersion as string) ?? result.resolvedVariant ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve any named flag with full explain output.
 * Read-only preview — no event written. (INV-FLAG8)
 */
export async function previewFlagResolution(
  flagKey: string,
  ctx: RuntimeContext,
): Promise<{
  flagKey: string;
  enabled: boolean | null;
  resolvedVariant: string | null;
  resolvedConfig: Record<string, unknown> | null;
  resolutionSource: string;
  explanation: string;
  preview: true;
  noWritePerformed: true;
}> {
  const { explainResolution } = await import("./variant-resolution");
  return explainResolution(flagKey, ctx);
}
