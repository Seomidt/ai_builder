/**
 * Billing Alert Management — Phase 4Q
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides alert lifecycle management for billing observability:
 *   - Upsert-style deduplication by alert_key + open/acknowledged status
 *   - Status transitions: open → acknowledged → resolved | suppressed
 *   - Historical alerts are always preserved (no destructive delete)
 *
 * Design rules:
 *   A) alert_key is the deduplication key — same class/scope generates one open alert
 *   B) Resolved/suppressed alerts remain historically queryable
 *   C) details must be structured JSON — no raw table dumps
 *   D) Alert objects are operational artifacts, NOT financial truth
 */

import { eq, and, desc, inArray } from "drizzle-orm";
import { db } from "../../db";
import { billingAlerts } from "@shared/schema";
import type { BillingAlert } from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpsertBillingAlertInput {
  alertType: string;
  severity: "info" | "warning" | "critical";
  scopeType: "global" | "tenant" | "billing_period" | "invoice" | "payment";
  scopeId?: string | null;
  alertKey: string;
  alertMessage: string;
  details?: Record<string, unknown> | null;
}

// ─── Upsert Alert (deduplicate by alert_key + active status) ─────────────────

export async function upsertBillingAlert(
  input: UpsertBillingAlertInput,
): Promise<BillingAlert> {
  const existing = await db
    .select()
    .from(billingAlerts)
    .where(
      and(
        eq(billingAlerts.alertKey, input.alertKey),
        inArray(billingAlerts.status, ["open", "acknowledged"]),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const [updated] = await db
      .update(billingAlerts)
      .set({
        lastDetectedAt: new Date(),
        alertMessage: input.alertMessage,
        details: input.details ?? null,
        severity: input.severity,
      })
      .where(eq(billingAlerts.id, existing[0].id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(billingAlerts)
    .values({
      alertType: input.alertType,
      severity: input.severity,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      alertKey: input.alertKey,
      status: "open",
      alertMessage: input.alertMessage,
      details: input.details ?? null,
      firstDetectedAt: new Date(),
      lastDetectedAt: new Date(),
    })
    .returning();

  return created;
}

// ─── List & Lookup ────────────────────────────────────────────────────────────

export async function listOpenBillingAlerts(
  limit = 50,
  severity?: "info" | "warning" | "critical",
): Promise<BillingAlert[]> {
  const conditions = [inArray(billingAlerts.status, ["open", "acknowledged"])];
  if (severity) conditions.push(eq(billingAlerts.severity, severity));

  return db
    .select()
    .from(billingAlerts)
    .where(and(...conditions))
    .orderBy(desc(billingAlerts.lastDetectedAt))
    .limit(limit);
}

export async function listBillingAlertsByScope(
  scopeType: string,
  scopeId: string,
  limit = 50,
): Promise<BillingAlert[]> {
  return db
    .select()
    .from(billingAlerts)
    .where(
      and(
        eq(billingAlerts.scopeType, scopeType),
        eq(billingAlerts.scopeId, scopeId),
      ),
    )
    .orderBy(desc(billingAlerts.lastDetectedAt))
    .limit(limit);
}

// ─── Status Transitions ───────────────────────────────────────────────────────

async function transitionAlertStatus(
  alertId: string,
  newStatus: "acknowledged" | "resolved" | "suppressed",
): Promise<BillingAlert | null> {
  const alert = await db
    .select()
    .from(billingAlerts)
    .where(eq(billingAlerts.id, alertId))
    .limit(1);
  if (alert.length === 0) return null;

  const updates: Record<string, unknown> = { status: newStatus };
  if (newStatus === "resolved") updates.resolvedAt = new Date();

  const [updated] = await db
    .update(billingAlerts)
    .set(updates)
    .where(eq(billingAlerts.id, alertId))
    .returning();

  return updated;
}

export async function acknowledgeBillingAlert(alertId: string): Promise<BillingAlert | null> {
  return transitionAlertStatus(alertId, "acknowledged");
}

export async function resolveBillingAlert(alertId: string): Promise<BillingAlert | null> {
  return transitionAlertStatus(alertId, "resolved");
}

export async function suppressBillingAlert(alertId: string): Promise<BillingAlert | null> {
  return transitionAlertStatus(alertId, "suppressed");
}

// ─── Explain Alert ────────────────────────────────────────────────────────────

export interface BillingAlertExplanation {
  alert: BillingAlert | null;
  isActive: boolean;
  ageMinutes: number | null;
  sinceLastDetectedMinutes: number | null;
  explanation: string;
}

export async function explainBillingAlert(alertId: string): Promise<BillingAlertExplanation> {
  const rows = await db
    .select()
    .from(billingAlerts)
    .where(eq(billingAlerts.id, alertId))
    .limit(1);

  const alert = rows[0] ?? null;
  if (!alert) {
    return {
      alert: null,
      isActive: false,
      ageMinutes: null,
      sinceLastDetectedMinutes: null,
      explanation: `No billing alert found for id: ${alertId}`,
    };
  }

  const now = Date.now();
  const ageMinutes = Math.round((now - new Date(alert.createdAt).getTime()) / 60000);
  const sinceLastDetectedMinutes = Math.round((now - new Date(alert.lastDetectedAt).getTime()) / 60000);
  const isActive = alert.status === "open" || alert.status === "acknowledged";

  return {
    alert,
    isActive,
    ageMinutes,
    sinceLastDetectedMinutes,
    explanation: `Alert '${alert.alertType}' (${alert.severity}) for scope ${alert.scopeType}/${alert.scopeId ?? "global'"}. Status: ${alert.status}. First detected ${ageMinutes}m ago, last detected ${sinceLastDetectedMinutes}m ago.`,
  };
}
