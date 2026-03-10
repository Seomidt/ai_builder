/**
 * AI Model Router
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Resolves a logical model key into a concrete { provider, model } route.
 * This is the single place where routing decisions are made.
 *
 * Phase 3C: simple table-based routing from AI_MODEL_ROUTES.
 * Phase 3E: async resolution with optional DB override lookup.
 *           Overrides are route_key-based, not feature-based.
 *           Features map to route keys; this layer never receives feature names.
 *
 * Resolution priority:
 *   1. tenant DB override  (if tenantId provided)
 *   2. global DB override
 *   3. code default from AI_MODEL_ROUTES
 *
 * Override failures are silent — code defaults are always the safety net.
 */

import { AI_MODEL_ROUTES, type AiModelKey, type AiModelRoute } from "./config";
import { loadOverride } from "./overrides";

export interface AiRoute extends AiModelRoute {
  /** The logical key that was resolved — useful for tracing */
  key: AiModelKey;
  /** True if a DB override was applied instead of the code default */
  overridden: boolean;
}

/**
 * Resolve a logical model key to a concrete provider + model pair.
 *
 * Checks DB overrides (tenant → global) before falling back to code defaults.
 * Always returns a valid AiRoute — never throws.
 *
 * @param modelKey  Logical route key (e.g. "default", "cheap", "coding")
 * @param tenantId  Optional tenant/org id for tenant-scoped override lookup
 */
export async function resolveRoute(
  modelKey: AiModelKey,
  tenantId?: string | null,
): Promise<AiRoute> {
  const codeDefault = AI_MODEL_ROUTES[modelKey] ?? AI_MODEL_ROUTES.default;

  try {
    const override = await loadOverride(modelKey, tenantId);
    if (override) {
      return { ...override, key: modelKey, overridden: true };
    }
  } catch (err) {
    console.warn(
      `[ai:router] override lookup threw unexpectedly for key=${modelKey}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return { ...codeDefault, key: modelKey, overridden: false };
}
