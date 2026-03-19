/**
 * AI Model Router
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Resolves a logical model key into a concrete { provider, model } route.
 * This is the single place where routing decisions are made.
 *
 * Phase 3C strategy: simple table-based routing from AI_MODEL_ROUTES.
 * No dynamic heuristics, no cost optimisation, no automatic failover.
 * Future phases can extend the routing strategy here without touching callers.
 */

import { AI_MODEL_ROUTES, type AiModelKey, type AiModelRoute } from "./config";

export interface AiRoute extends AiModelRoute {
  /** The logical key that was resolved — useful for tracing */
  key: AiModelKey;
}

/**
 * Resolve a logical model key to a concrete provider + model pair.
 *
 * Falls back to the "default" route if the requested key is not found.
 * Always returns a valid AiRoute — never throws.
 */
export function resolveRoute(modelKey: AiModelKey): AiRoute {
  const route = AI_MODEL_ROUTES[modelKey] ?? AI_MODEL_ROUTES.default;
  return { ...route, key: modelKey };
}
