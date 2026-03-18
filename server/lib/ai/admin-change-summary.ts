/**
 * Admin Change Summary Helpers — Phase 4P
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides read-only inspection helpers for admin change request history:
 *   - List change requests
 *   - Inspect individual requests and events
 *   - Explain full result chain for a completed change
 *
 * These helpers are intended for support, finance, and internal ops use.
 * No writes are performed by this module.
 */

import { eq, desc } from "drizzle-orm";
import { db } from "../../db";
import { adminChangeRequests, adminChangeEvents } from "@shared/schema";
import type { AdminChangeRequest, AdminChangeEvent } from "@shared/schema";

// ─── List & Lookup ────────────────────────────────────────────────────────────

export async function listAdminChangeRequests(limit = 50): Promise<AdminChangeRequest[]> {
  return db
    .select()
    .from(adminChangeRequests)
    .orderBy(desc(adminChangeRequests.createdAt))
    .limit(limit);
}

export async function getAdminChangeRequestById(id: string): Promise<AdminChangeRequest | null> {
  const rows = await db
    .select()
    .from(adminChangeRequests)
    .where(eq(adminChangeRequests.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listAdminChangeEvents(changeRequestId: string): Promise<AdminChangeEvent[]> {
  return db
    .select()
    .from(adminChangeEvents)
    .where(eq(adminChangeEvents.adminChangeRequestId, changeRequestId))
    .orderBy(adminChangeEvents.createdAt);
}

// ─── Explain Full Result Chain ────────────────────────────────────────────────

export interface AdminChangeResultExplanation {
  changeRequestId: string;
  changeRequest: AdminChangeRequest | null;
  requestPayload: Record<string, unknown> | null;
  dryRunSummary: Record<string, unknown> | null;
  appliedResult: Record<string, unknown> | null;
  events: AdminChangeEvent[];
  finalStatus: string | null;
  errorMessage: string | null;
  timeline: { eventType: string; createdAt: string; metadata: Record<string, unknown> | null }[];
}

export async function explainAdminChangeResult(
  changeRequestId: string,
): Promise<AdminChangeResultExplanation> {
  const requestRows = await db
    .select()
    .from(adminChangeRequests)
    .where(eq(adminChangeRequests.id, changeRequestId))
    .limit(1);

  const changeRequest = requestRows[0] ?? null;

  const events = await db
    .select()
    .from(adminChangeEvents)
    .where(eq(adminChangeEvents.adminChangeRequestId, changeRequestId))
    .orderBy(adminChangeEvents.createdAt);

  return {
    changeRequestId,
    changeRequest,
    requestPayload: changeRequest?.requestPayload as Record<string, unknown> | null ?? null,
    dryRunSummary: changeRequest?.dryRunSummary as Record<string, unknown> | null ?? null,
    appliedResult: changeRequest?.appliedResult as Record<string, unknown> | null ?? null,
    events,
    finalStatus: changeRequest?.status ?? null,
    errorMessage: changeRequest?.errorMessage ?? null,
    timeline: events.map((e) => ({
      eventType: e.eventType,
      createdAt: new Date(e.createdAt).toISOString(),
      metadata: e.metadata as Record<string, unknown> | null ?? null,
    })),
  };
}
