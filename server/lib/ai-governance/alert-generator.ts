/**
 * Phase 16 — Alert Generator
 * Creates and manages AI usage alerts triggered by budget thresholds.
 *
 * INV-GOV-1: Never throws — fail open.
 * INV-GOV-3: Soft limit alerts are warnings — do not block execution.
 * INV-GOV-4: All alerts are strictly per-tenant.
 * INV-GOV-5: All alert events are recorded for audit trail.
 */

import { db } from "../../db";
import { aiUsageAlerts } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { checkBudgetBeforeCall, type BudgetState } from "./budget-checker";

export type AlertType = "soft_limit" | "hard_limit" | "daily_limit" | "daily_soft";

/**
 * Generate a usage alert and persist it.
 * INV-GOV-1: Never throws.
 * INV-GOV-5: Alert recorded immediately upon creation.
 */
export async function generateUsageAlert(params: {
  tenantId: string;
  alertType: AlertType | string;
  thresholdPercent: number;
  usagePercent: number;
}): Promise<{ id: string } | null> {
  try {
    const [row] = await db
      .insert(aiUsageAlerts)
      .values({
        tenantId: params.tenantId,
        alertType: params.alertType,
        thresholdPercent: String(params.thresholdPercent),
        usagePercent: String(params.usagePercent),
      })
      .returning({ id: aiUsageAlerts.id });
    return row ?? null;
  } catch {
    return null; // INV-GOV-1: never throw
  }
}

/**
 * List recent alerts for a tenant.
 * INV-GOV-4: Results strictly scoped to the given tenant.
 */
export async function listTenantAlerts(tenantId: string, limit = 50) {
  try {
    return await db
      .select()
      .from(aiUsageAlerts)
      .where(eq(aiUsageAlerts.tenantId, tenantId))
      .orderBy(desc(aiUsageAlerts.triggeredAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * List all alerts across all tenants (admin view).
 */
export async function listAllAlerts(limit = 100) {
  try {
    return await db
      .select()
      .from(aiUsageAlerts)
      .orderBy(desc(aiUsageAlerts.triggeredAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Check tenant budget state and auto-generate alert if threshold crossed.
 * INV-GOV-1: Never throws.
 * INV-GOV-3: Soft limit alert is informational only.
 * INV-GOV-5: Alert is recorded to the database.
 * Returns the generated alert id, or null if no alert triggered.
 */
export async function checkAndGenerateAlerts(tenantId: string): Promise<{
  alertGenerated: boolean;
  alertId: string | null;
  state: BudgetState;
  usagePercent: number;
}> {
  try {
    const check = await checkBudgetBeforeCall(tenantId);

    if (check.state === "hard_limit") {
      const alert = await generateUsageAlert({
        tenantId,
        alertType: "hard_limit",
        thresholdPercent: 100,
        usagePercent: check.usagePercent,
      });
      return { alertGenerated: true, alertId: alert?.id ?? null, state: check.state, usagePercent: check.usagePercent };
    }

    if (check.state === "soft_limit") {
      const alert = await generateUsageAlert({
        tenantId,
        alertType: "soft_limit",
        thresholdPercent: Number(80), // default soft limit pct
        usagePercent: check.usagePercent,
      });
      return { alertGenerated: true, alertId: alert?.id ?? null, state: check.state, usagePercent: check.usagePercent };
    }

    return { alertGenerated: false, alertId: null, state: check.state, usagePercent: check.usagePercent };
  } catch {
    return { alertGenerated: false, alertId: null, state: "no_budget", usagePercent: 0 };
  }
}
