/**
 * route-logging.ts — Audit log for routing decisions.
 *
 * Inserts into chat_route_decisions table.
 * Fire-and-forget: never throws (errors are suppressed to avoid
 * polluting the critical chat path).
 */

import { db }                  from "../../db.ts";
import { chatRouteDecisions }  from "../../../shared/schema.ts";

export interface RouteDecisionLog {
  tenantId:       string;
  conversationId?: string;
  userId:         string;
  routeType:      string;
  attachmentIds?: string[];
  expertIds?:     string[];
  routeReason:    string;
  expertScore?:   number | null;
  hasAttachment:  boolean;
  hasExperts:     boolean;
}

/**
 * Persist a routing decision to the audit log.
 * Safe to call fire-and-forget (errors are logged but not thrown).
 */
export async function logRouteDecision(log: RouteDecisionLog): Promise<void> {
  try {
    await db.insert(chatRouteDecisions).values({
      tenantId:       log.tenantId,
      conversationId: log.conversationId ?? null,
      userId:         log.userId,
      routeType:      log.routeType,
      attachmentIds:  log.attachmentIds ?? null,
      expertIds:      log.expertIds ?? null,
      routeReason:    log.routeReason,
      expertScore:    log.expertScore != null ? String(log.expertScore) : null,
      hasAttachment:  log.hasAttachment,
      hasExperts:     log.hasExperts,
    });
  } catch (err) {
    console.error("[route-logging] Failed to persist routing decision:", (err as Error).message);
  }
}
