/**
 * Admin Routes — Phase 4P
 *
 * INTERNAL/ADMIN ONLY — These routes must never be exposed to tenants.
 *
 * Provides the minimal route foundation for:
 *   - Pricing version previews and apply
 *   - Plan previews and apply
 *   - Tenant subscription previews and apply
 *   - Admin change request listing and inspection
 *
 * All routes are prefixed with /api/admin/
 * Input validation uses Zod before passing to helpers.
 * Errors propagate as 400/500 with structured JSON.
 */

import { type Express, type Request, type Response } from "express";
import { z } from "zod";
import {
  previewCreateProviderPricingVersion,
  applyCreateProviderPricingVersion,
  previewCreateCustomerPricingVersion,
  applyCreateCustomerPricingVersion,
  previewCreateStoragePricingVersion,
  applyCreateStoragePricingVersion,
  previewCreateCustomerStoragePricingVersion,
  applyCreateCustomerStoragePricingVersion,
} from "../lib/ai/admin-pricing";
import {
  previewCreateSubscriptionPlan,
  applyCreateSubscriptionPlan,
  previewReplacePlanEntitlements,
  applyReplacePlanEntitlements,
  archiveSubscriptionPlan,
  listAdminSubscriptionPlans,
  explainPlanDefinition,
} from "../lib/ai/admin-plans";
import {
  previewTenantPlanChange,
  applyTenantPlanChange,
  previewTenantPlanCancellation,
  applyTenantPlanCancellation,
  listTenantSubscriptionHistory,
} from "../lib/ai/admin-tenant-subscriptions";
import {
  previewPricingImpactForTenant,
  previewPlanImpactForTenant,
  previewGlobalPricingWindowChange,
  explainAdminChangePreview,
} from "../lib/ai/admin-commercial-preview";
import {
  listAdminChangeRequests,
  getAdminChangeRequestById,
  listAdminChangeEvents,
  explainAdminChangeResult,
} from "../lib/ai/admin-change-summary";
import {
  explainAdminChangeRetentionPolicy,
  previewPendingAdminChangesOlderThan,
  previewFailedAdminChangesOlderThan,
  previewAppliedAdminChangesWithoutEvents,
  previewPlanRowsStillReferencedHistorically,
} from "../lib/ai/admin-change-retention";
import {
  createGlobalBillingMetricsSnapshot,
  createTenantBillingMetricsSnapshot,
  createBillingPeriodMetricsSnapshot,
  getLatestGlobalBillingMetrics,
  getLatestTenantBillingMetrics,
  getLatestBillingPeriodMetrics,
} from "../lib/ai/billing-observability";
import { runBillingAnomalyScan } from "../lib/ai/billing-anomalies";
import {
  getInvoiceMonitoringSummary,
  getPaymentMonitoringSummary,
  getSubscriptionMonitoringSummary,
  getReconciliationMonitoringSummary,
  getAllowanceMonitoringSummary,
  getTenantMonetizationHealthSummary,
  getGlobalMonetizationHealthSummary,
} from "../lib/ai/billing-monitoring-summary";
import {
  upsertBillingAlert,
  listOpenBillingAlerts,
  listBillingAlertsByScope,
  acknowledgeBillingAlert,
  resolveBillingAlert,
  suppressBillingAlert,
  explainBillingAlert,
} from "../lib/ai/billing-alerts";
import {
  explainBillingMonitoringRetentionPolicy,
  previewFailedMetricsSnapshotsOlderThan,
  previewOpenCriticalAlertsOlderThan,
  previewMonitoringGaps,
  previewTenantsWithoutRecentMetricsSnapshots,
} from "../lib/ai/billing-monitoring-retention";

// Phase 4S: Billing Recovery & Integrity
import { runBillingIntegrityScan } from "../lib/ai/billing-integrity";
import {
  previewSnapshotRebuild,
  applySnapshotRebuild,
  previewInvoiceTotalsRebuild,
  applyInvoiceTotalsRebuild,
} from "../lib/ai/billing-recovery";
import {
  listRecoveryRuns,
  getRecoveryRunDetail,
  explainRecoveryRun,
  getRecoveryRunStats,
} from "../lib/ai/billing-recovery-summary";
import {
  getRecoveryRunAgeReport,
  getRecoveryActionStats,
  findRetentionCandidates,
  findStuckRecoveryRuns,
  getRecoveryRunDailyTrend,
} from "../lib/ai/billing-recovery-retention";

// Phase 4R: Automated Billing Operations
import { ensureBillingJobDefinitions } from "../lib/ai/billing-jobs";
import { runBillingJob, retryBillingJobRun } from "../lib/ai/billing-operations";
import {
  listBillingJobDefinitions,
  listRecentBillingJobRuns,
  getBillingJobRunById,
  getBillingJobHealthSummary,
  previewStaleBillingJobRuns,
  previewFailedBillingJobs,
} from "../lib/ai/billing-job-health";
import {
  triggerDueBillingJobs,
  getSchedulerStatus,
} from "../lib/ai/billing-scheduler";
import {
  explainBillingOpsRetentionPolicy,
  previewCompletedJobRunsOlderThan,
  previewFailedJobRunsOlderThan,
  previewTimedOutJobRunsOlderThan,
  previewJobDefinitionsWithoutRuns,
  previewDuplicateStartedRuns,
} from "../lib/ai/billing-ops-retention";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const createProviderPricingVersionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  pricingVersion: z.string().min(1),
  effectiveFrom: z.string().transform((s) => new Date(s)),
  effectiveTo: z.string().transform((s) => new Date(s)).nullable().optional(),
  inputTokenPriceUsd: z.string(),
  outputTokenPriceUsd: z.string(),
  cachedInputTokenPriceUsd: z.string().optional(),
  reasoningTokenPriceUsd: z.string().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  requestedBy: z.string().nullable().optional(),
});

const createCustomerPricingVersionSchema = z.object({
  tenantId: z.string().min(1),
  feature: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  pricingVersion: z.string().min(1),
  pricingMode: z.string().min(1),
  pricingSource: z.string().optional(),
  effectiveFrom: z.string().transform((s) => new Date(s)),
  effectiveTo: z.string().transform((s) => new Date(s)).nullable().optional(),
  multiplier: z.string().nullable().optional(),
  flatMarkupUsd: z.string().nullable().optional(),
  perRequestMarkupUsd: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  requestedBy: z.string().nullable().optional(),
});

const createStoragePricingVersionSchema = z.object({
  storageProvider: z.string().optional(),
  storageProduct: z.string().optional(),
  metricType: z.string().min(1),
  pricingVersion: z.string().min(1),
  effectiveFrom: z.string().transform((s) => new Date(s)),
  effectiveTo: z.string().transform((s) => new Date(s)).nullable().optional(),
  includedUsage: z.string().nullable().optional(),
  unitPriceUsd: z.string(),
  metadata: z.record(z.unknown()).nullable().optional(),
  requestedBy: z.string().nullable().optional(),
});

const createCustomerStoragePricingVersionSchema = z.object({
  tenantId: z.string().min(1),
  storageProvider: z.string().optional(),
  storageProduct: z.string().optional(),
  metricType: z.string().min(1),
  pricingVersion: z.string().min(1),
  effectiveFrom: z.string().transform((s) => new Date(s)),
  effectiveTo: z.string().transform((s) => new Date(s)).nullable().optional(),
  multiplier: z.string().nullable().optional(),
  flatMarkupUsd: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  requestedBy: z.string().nullable().optional(),
});

const createSubscriptionPlanSchema = z.object({
  planCode: z.string().min(1),
  planName: z.string().min(1),
  billingInterval: z.enum(["monthly", "yearly"]),
  basePriceUsd: z.string(),
  currency: z.string().optional(),
  effectiveFrom: z.string().transform((s) => new Date(s)),
  effectiveTo: z.string().transform((s) => new Date(s)).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  requestedBy: z.string().nullable().optional(),
});

const entitlementInputSchema = z.object({
  entitlementKey: z.string().min(1),
  entitlementType: z.enum(["limit", "included_usage", "feature_flag", "overage_rule"]),
  numericValue: z.string().nullable().optional(),
  textValue: z.string().nullable().optional(),
  booleanValue: z.boolean().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

const replacePlanEntitlementsSchema = z.object({
  entitlementSet: z.array(entitlementInputSchema),
  requestedBy: z.string().nullable().optional(),
});

const tenantPlanChangeSchema = z.object({
  newPlanId: z.string().min(1),
  effectiveFrom: z.string().transform((s) => new Date(s)),
  requestedBy: z.string().nullable().optional(),
});

const tenantPlanCancellationSchema = z.object({
  effectiveTo: z.string().transform((s) => new Date(s)),
  requestedBy: z.string().nullable().optional(),
});

const metricsWindowSchema = z.object({
  windowStart: z.string().transform((s) => new Date(s)),
  windowEnd: z.string().transform((s) => new Date(s)),
});

const upsertBillingAlertSchema = z.object({
  alertType: z.string().min(1),
  severity: z.enum(["info", "warning", "critical"]),
  scopeType: z.enum(["global", "tenant", "billing_period", "invoice", "payment"]),
  scopeId: z.string().nullable().optional(),
  alertKey: z.string().min(1),
  alertMessage: z.string().min(1),
  details: z.record(z.unknown()).nullable().optional(),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerAdminRoutes(app: Express): void {

  // ── Pricing: Provider ──────────────────────────────────────────────────────
  app.post("/api/admin/pricing/provider/preview", async (req: Request, res: Response) => {
    try {
      const input = createProviderPricingVersionSchema.parse(req.body);
      const result = await previewCreateProviderPricingVersion(input);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/pricing/provider/apply", async (req: Request, res: Response) => {
    try {
      const input = createProviderPricingVersionSchema.parse(req.body);
      const result = await applyCreateProviderPricingVersion(input);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Pricing: Customer ──────────────────────────────────────────────────────
  app.post("/api/admin/pricing/customer/preview", async (req: Request, res: Response) => {
    try {
      const input = createCustomerPricingVersionSchema.parse(req.body);
      const result = await previewCreateCustomerPricingVersion(input);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/pricing/customer/apply", async (req: Request, res: Response) => {
    try {
      const input = createCustomerPricingVersionSchema.parse(req.body);
      const result = await applyCreateCustomerPricingVersion(input);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Pricing: Storage ───────────────────────────────────────────────────────
  app.post("/api/admin/pricing/storage/preview", async (req: Request, res: Response) => {
    try {
      const input = createStoragePricingVersionSchema.parse(req.body);
      const result = await previewCreateStoragePricingVersion(input);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/pricing/storage/apply", async (req: Request, res: Response) => {
    try {
      const input = createStoragePricingVersionSchema.parse(req.body);
      const result = await applyCreateStoragePricingVersion(input);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Pricing: Customer Storage ──────────────────────────────────────────────
  app.post("/api/admin/pricing/customer-storage/preview", async (req: Request, res: Response) => {
    try {
      const input = createCustomerStoragePricingVersionSchema.parse(req.body);
      const result = await previewCreateCustomerStoragePricingVersion(input);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/pricing/customer-storage/apply", async (req: Request, res: Response) => {
    try {
      const input = createCustomerStoragePricingVersionSchema.parse(req.body);
      const result = await applyCreateCustomerStoragePricingVersion(input);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Plans ──────────────────────────────────────────────────────────────────
  app.get("/api/admin/plans", async (_req: Request, res: Response) => {
    try {
      const plans = await listAdminSubscriptionPlans(100);
      res.json(plans);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/plans/preview", async (req: Request, res: Response) => {
    try {
      const input = createSubscriptionPlanSchema.parse(req.body);
      const result = await previewCreateSubscriptionPlan(input);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/plans/apply", async (req: Request, res: Response) => {
    try {
      const input = createSubscriptionPlanSchema.parse(req.body);
      const result = await applyCreateSubscriptionPlan(input);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/plans/:planId/explain", async (req: Request, res: Response) => {
    try {
      const planId = String(req.params.planId);
      const result = await explainPlanDefinition(planId);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/plans/:planId/entitlements/preview", async (req: Request, res: Response) => {
    try {
      const planId = String(req.params.planId);
      const body = replacePlanEntitlementsSchema.parse(req.body);
      const result = await previewReplacePlanEntitlements(planId, body.entitlementSet);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/plans/:planId/entitlements/apply", async (req: Request, res: Response) => {
    try {
      const planId = String(req.params.planId);
      const body = replacePlanEntitlementsSchema.parse(req.body);
      const result = await applyReplacePlanEntitlements(planId, body.entitlementSet, body.requestedBy ?? null);
      res.status(200).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/plans/:planId/archive", async (req: Request, res: Response) => {
    try {
      const planId = String(req.params.planId);
      const requestedBy = (req.body as Record<string, string>)?.requestedBy ?? null;
      const result = await archiveSubscriptionPlan(planId, requestedBy);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Tenant Subscriptions ───────────────────────────────────────────────────
  app.get("/api/admin/tenants/:tenantId/subscriptions", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const history = await listTenantSubscriptionHistory(tenantId);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/tenants/:tenantId/subscriptions/change/preview", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const body = tenantPlanChangeSchema.parse(req.body);
      const result = await previewTenantPlanChange(tenantId, body.newPlanId, body.effectiveFrom);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/tenants/:tenantId/subscriptions/change/apply", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const body = tenantPlanChangeSchema.parse(req.body);
      const result = await applyTenantPlanChange(tenantId, body.newPlanId, body.effectiveFrom, body.requestedBy ?? null);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/tenants/:tenantId/subscriptions/cancel/preview", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const body = tenantPlanCancellationSchema.parse(req.body);
      const result = await previewTenantPlanCancellation(tenantId, body.effectiveTo);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/tenants/:tenantId/subscriptions/cancel/apply", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const body = tenantPlanCancellationSchema.parse(req.body);
      const result = await applyTenantPlanCancellation(tenantId, body.effectiveTo, body.requestedBy ?? null);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Commercial Preview ─────────────────────────────────────────────────────
  app.post("/api/admin/preview/pricing-impact/:tenantId", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const atTime = req.body.atTime ? new Date(req.body.atTime as string) : new Date();
      const result = await previewPricingImpactForTenant(tenantId, atTime, req.body.proposedChanges ?? {});
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/preview/plan-impact/:tenantId", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const atTime = req.body.atTime ? new Date(req.body.atTime as string) : new Date();
      const proposedPlanId = (req.body as Record<string, string>).proposedPlanId;
      if (!proposedPlanId) return res.status(400).json({ error: "proposedPlanId required" });
      const result = await previewPlanImpactForTenant(tenantId, atTime, proposedPlanId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/preview/global-pricing-window", async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, string>;
      const result = await previewGlobalPricingWindowChange({
        provider: body.provider,
        model: body.model,
        proposedEffectiveFrom: new Date(body.proposedEffectiveFrom),
        proposedEffectiveTo: body.proposedEffectiveTo ? new Date(body.proposedEffectiveTo) : null,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/preview/change/:changeRequestId", async (req: Request, res: Response) => {
    try {
      const changeRequestId = String(req.params.changeRequestId);
      const result = await explainAdminChangePreview(changeRequestId);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // ── Admin Change Requests ──────────────────────────────────────────────────
  app.get("/api/admin/changes", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const changes = await listAdminChangeRequests(limit);
      res.json(changes);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/changes/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const change = await getAdminChangeRequestById(id);
      if (!change) return res.status(404).json({ error: "Admin change request not found" });
      res.json(change);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/changes/:id/events", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const events = await listAdminChangeEvents(id);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/changes/:id/explain", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const result = await explainAdminChangeResult(id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Retention & Operational Safety ────────────────────────────────────────
  app.get("/api/admin/retention/policy", (_req: Request, res: Response) => {
    res.json(explainAdminChangeRetentionPolicy());
  });

  app.get("/api/admin/retention/pending-older-than/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewPendingAdminChangesOlderThan(days);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/retention/failed-older-than/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewFailedAdminChangesOlderThan(days);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/retention/applied-without-events", async (_req: Request, res: Response) => {
    try {
      const result = await previewAppliedAdminChangesWithoutEvents();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/retention/historically-referenced-plans", async (_req: Request, res: Response) => {
    try {
      const result = await previewPlanRowsStillReferencedHistorically();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 4Q: Billing Monitoring — Metrics Snapshots ──────────────────────

  app.post("/api/admin/monitoring/snapshots/global", async (req: Request, res: Response) => {
    try {
      const parsed = metricsWindowSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const result = await createGlobalBillingMetricsSnapshot(
        parsed.data.windowStart,
        parsed.data.windowEnd,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/monitoring/snapshots/tenant/:tenantId", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const parsed = metricsWindowSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const result = await createTenantBillingMetricsSnapshot(
        tenantId,
        parsed.data.windowStart,
        parsed.data.windowEnd,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/monitoring/snapshots/billing-period/:billingPeriodId", async (req: Request, res: Response) => {
    try {
      const billingPeriodId = String(req.params.billingPeriodId);
      const parsed = metricsWindowSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const result = await createBillingPeriodMetricsSnapshot(
        billingPeriodId,
        parsed.data.windowStart,
        parsed.data.windowEnd,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/snapshots/global/latest", async (_req: Request, res: Response) => {
    try {
      const result = await getLatestGlobalBillingMetrics();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/snapshots/tenant/:tenantId/latest", async (req: Request, res: Response) => {
    try {
      const result = await getLatestTenantBillingMetrics(String(req.params.tenantId));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/snapshots/billing-period/:billingPeriodId/latest", async (req: Request, res: Response) => {
    try {
      const result = await getLatestBillingPeriodMetrics(String(req.params.billingPeriodId));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 4Q: Billing Monitoring — Anomaly Scan ───────────────────────────

  app.post("/api/admin/monitoring/anomaly-scan", async (req: Request, res: Response) => {
    try {
      const parsed = metricsWindowSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const result = await runBillingAnomalyScan(parsed.data.windowStart, parsed.data.windowEnd);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 4Q: Billing Monitoring — Summaries ─────────────────────────────

  app.get("/api/admin/monitoring/summary/invoices", async (req: Request, res: Response) => {
    try {
      const { windowStart, windowEnd, tenantId } = req.query as Record<string, string | undefined>;
      const result = await getInvoiceMonitoringSummary(
        windowStart ? new Date(windowStart) : undefined,
        windowEnd ? new Date(windowEnd) : undefined,
        tenantId,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/summary/payments", async (req: Request, res: Response) => {
    try {
      const { windowStart, windowEnd, tenantId } = req.query as Record<string, string | undefined>;
      const result = await getPaymentMonitoringSummary(
        windowStart ? new Date(windowStart) : undefined,
        windowEnd ? new Date(windowEnd) : undefined,
        tenantId,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/summary/subscriptions", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.query as Record<string, string | undefined>;
      const result = await getSubscriptionMonitoringSummary(tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/summary/reconciliation", async (req: Request, res: Response) => {
    try {
      const { windowStart, windowEnd } = req.query as Record<string, string | undefined>;
      const result = await getReconciliationMonitoringSummary(
        windowStart ? new Date(windowStart) : undefined,
        windowEnd ? new Date(windowEnd) : undefined,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/summary/allowances", async (req: Request, res: Response) => {
    try {
      const { windowStart, windowEnd, tenantId } = req.query as Record<string, string | undefined>;
      const result = await getAllowanceMonitoringSummary(
        windowStart ? new Date(windowStart) : undefined,
        windowEnd ? new Date(windowEnd) : undefined,
        tenantId,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/summary/health/global", async (req: Request, res: Response) => {
    try {
      const { windowStart, windowEnd } = req.query as Record<string, string | undefined>;
      if (!windowStart || !windowEnd) {
        return res.status(400).json({ error: "windowStart and windowEnd query params required" });
      }
      const result = await getGlobalMonetizationHealthSummary(
        new Date(windowStart),
        new Date(windowEnd),
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/summary/health/tenant/:tenantId", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.params.tenantId);
      const { windowStart, windowEnd } = req.query as Record<string, string | undefined>;
      if (!windowStart || !windowEnd) {
        return res.status(400).json({ error: "windowStart and windowEnd query params required" });
      }
      const result = await getTenantMonetizationHealthSummary(
        tenantId,
        new Date(windowStart),
        new Date(windowEnd),
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 4Q: Billing Monitoring — Alerts ────────────────────────────────

  app.post("/api/admin/monitoring/alerts", async (req: Request, res: Response) => {
    try {
      const parsed = upsertBillingAlertSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const result = await upsertBillingAlert(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/alerts", async (req: Request, res: Response) => {
    try {
      const { severity, limit } = req.query as Record<string, string | undefined>;
      const parsedLimit = limit ? Number(limit) : 50;
      const result = await listOpenBillingAlerts(
        parsedLimit,
        severity as "info" | "warning" | "critical" | undefined,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/alerts/scope/:scopeType/:scopeId", async (req: Request, res: Response) => {
    try {
      const scopeType = String(req.params.scopeType);
      const scopeId = String(req.params.scopeId);
      const { limit } = req.query as Record<string, string | undefined>;
      const result = await listBillingAlertsByScope(scopeType, scopeId, limit ? Number(limit) : 50);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/alerts/:alertId/explain", async (req: Request, res: Response) => {
    try {
      const result = await explainBillingAlert(String(req.params.alertId));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/monitoring/alerts/:alertId/acknowledge", async (req: Request, res: Response) => {
    try {
      const result = await acknowledgeBillingAlert(String(req.params.alertId));
      if (!result) return res.status(404).json({ error: "Alert not found" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/monitoring/alerts/:alertId/resolve", async (req: Request, res: Response) => {
    try {
      const result = await resolveBillingAlert(String(req.params.alertId));
      if (!result) return res.status(404).json({ error: "Alert not found" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/monitoring/alerts/:alertId/suppress", async (req: Request, res: Response) => {
    try {
      const result = await suppressBillingAlert(String(req.params.alertId));
      if (!result) return res.status(404).json({ error: "Alert not found" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 4Q: Billing Monitoring — Retention Helpers ────────────────────

  app.get("/api/admin/monitoring/retention/policy", (_req: Request, res: Response) => {
    res.json(explainBillingMonitoringRetentionPolicy());
  });

  app.get("/api/admin/monitoring/retention/failed-snapshots-older-than/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewFailedMetricsSnapshotsOlderThan(days);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/retention/open-critical-alerts-older-than/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewOpenCriticalAlertsOlderThan(days);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/retention/monitoring-gaps", async (req: Request, res: Response) => {
    try {
      const { windowStart, windowEnd } = req.query as Record<string, string | undefined>;
      if (!windowStart || !windowEnd) {
        return res.status(400).json({ error: "windowStart and windowEnd query params required" });
      }
      const result = await previewMonitoringGaps(new Date(windowStart), new Date(windowEnd));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/monitoring/retention/tenants-without-recent-snapshots/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewTenantsWithoutRecentMetricsSnapshots(days);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 4R: Automated Billing Operations Routes ───────────────────────────

  // Job definitions
  app.get("/api/admin/billing-ops/jobs", async (_req: Request, res: Response) => {
    try {
      const definitions = await listBillingJobDefinitions();
      res.json({ definitions });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Seed predefined job definitions
  app.post("/api/admin/billing-ops/jobs/seed", async (_req: Request, res: Response) => {
    try {
      const result = await ensureBillingJobDefinitions();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Job runs list
  app.get("/api/admin/billing-ops/runs", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit as string || "50"), 200);
      const runs = await listRecentBillingJobRuns(isNaN(limit) ? 50 : limit);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get a specific run
  app.get("/api/admin/billing-ops/runs/:runId", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const run = await getBillingJobRunById(runId);
      if (!run) return res.status(404).json({ error: `Run not found: ${runId}` });
      res.json({ run });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Manually run a job
  app.post("/api/admin/billing-ops/jobs/:jobKey/run", async (req: Request, res: Response) => {
    try {
      const jobKey = String(req.params.jobKey);
      const { scopeType, scopeId, metadata } = req.body as {
        scopeType?: string;
        scopeId?: string;
        metadata?: Record<string, unknown>;
      };
      const result = await runBillingJob(jobKey, {
        triggerType: "manual",
        scopeType: scopeType as "global" | "tenant" | "billing_period" | undefined,
        scopeId,
        metadata,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Retry a failed run
  app.post("/api/admin/billing-ops/runs/:runId/retry", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const result = await retryBillingJobRun(runId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Health summary
  app.get("/api/admin/billing-ops/health", async (req: Request, res: Response) => {
    try {
      const windowHours = Math.max(1, Number(req.query.windowHours as string || "24"));
      const summary = await getBillingJobHealthSummary(isNaN(windowHours) ? 24 : windowHours);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Stale/failed job inspection
  app.get("/api/admin/billing-ops/inspections/stale-runs", async (req: Request, res: Response) => {
    try {
      const olderThanMinutes = Number(req.query.olderThanMinutes as string || "0");
      const result = await previewStaleBillingJobRuns(isNaN(olderThanMinutes) ? 0 : olderThanMinutes);
      res.json({ staleRuns: result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/billing-ops/inspections/failed-runs/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewFailedBillingJobs(days > 0 ? days : 50);
      res.json({ failedRuns: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Scheduler trigger (internal only)
  app.post("/api/admin/billing-ops/scheduler/trigger", async (_req: Request, res: Response) => {
    try {
      const result = await triggerDueBillingJobs();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Scheduler status
  app.get("/api/admin/billing-ops/scheduler/status", async (_req: Request, res: Response) => {
    try {
      const status = await getSchedulerStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Retention inspection helpers
  app.get("/api/admin/billing-ops/retention/policy", (_req: Request, res: Response) => {
    res.json(explainBillingOpsRetentionPolicy());
  });

  app.get("/api/admin/billing-ops/retention/completed-runs/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewCompletedJobRunsOlderThan(days);
      res.json({ completedRuns: result, count: result.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/billing-ops/retention/failed-runs/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewFailedJobRunsOlderThan(days);
      res.json({ failedRuns: result, count: result.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/billing-ops/retention/timed-out-runs/:days", async (req: Request, res: Response) => {
    try {
      const days = Number(String(req.params.days));
      const result = await previewTimedOutJobRunsOlderThan(days);
      res.json({ timedOutRuns: result, count: result.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/billing-ops/retention/definitions-without-runs", async (_req: Request, res: Response) => {
    try {
      const result = await previewJobDefinitionsWithoutRuns();
      res.json({ definitions: result, count: result.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/billing-ops/retention/duplicate-started-runs", async (_req: Request, res: Response) => {
    try {
      const result = await previewDuplicateStartedRuns();
      res.json({ duplicateGroups: result, count: result.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 4S: Billing Recovery & Integrity Routes ───────────────────────────

  // Integrity scan — read-only, always safe to call
  app.post("/api/admin/billing-recovery/scan", async (req: Request, res: Response) => {
    try {
      const bodySchema = z.object({
        scopeType: z.enum(["global", "tenant", "billing_period"]).optional(),
        scopeId: z.string().nullable().optional(),
        checks: z
          .array(
            z.enum([
              "ai_usage_gaps",
              "storage_usage_gaps",
              "snapshot_drift",
              "invoice_arithmetic",
              "stuck_wallet_debits",
            ]),
          )
          .optional(),
        stuckWalletThresholdHours: z.number().int().positive().optional(),
        snapshotDriftThresholdPct: z.number().positive().optional(),
        limit: z.number().int().positive().max(500).optional(),
      });
      const body = bodySchema.parse(req.body);
      const result = await runBillingIntegrityScan(body);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Preview snapshot rebuild — dry-run, never writes
  app.post("/api/admin/billing-recovery/preview/snapshot-rebuild", async (req: Request, res: Response) => {
    try {
      const bodySchema = z.object({
        billingPeriodId: z.string().min(1),
        tenantId: z.string().nullable().optional(),
      });
      const body = bodySchema.parse(req.body);
      const preview = await previewSnapshotRebuild(body.billingPeriodId, body.tenantId ?? null);
      res.json(preview);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Preview invoice totals rebuild — dry-run, never writes
  app.post("/api/admin/billing-recovery/preview/invoice-totals-rebuild", async (req: Request, res: Response) => {
    try {
      const bodySchema = z.object({
        scopeType: z.enum(["global", "tenant", "billing_period"]),
        scopeId: z.string().nullable().optional(),
      });
      const body = bodySchema.parse(req.body);
      const preview = await previewInvoiceTotalsRebuild(body.scopeType, body.scopeId ?? null);
      res.json(preview);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Apply snapshot rebuild
  app.post("/api/admin/billing-recovery/apply/snapshot-rebuild", async (req: Request, res: Response) => {
    try {
      const bodySchema = z.object({
        billingPeriodId: z.string().min(1),
        tenantId: z.string().nullable().optional(),
        reason: z.string().min(1),
      });
      const body = bodySchema.parse(req.body);
      const result = await applySnapshotRebuild(
        body.billingPeriodId,
        body.tenantId ?? null,
        "manual",
        body.reason,
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Apply invoice totals rebuild
  app.post("/api/admin/billing-recovery/apply/invoice-totals-rebuild", async (req: Request, res: Response) => {
    try {
      const bodySchema = z.object({
        scopeType: z.enum(["global", "tenant", "billing_period"]),
        scopeId: z.string().nullable().optional(),
        reason: z.string().min(1),
      });
      const body = bodySchema.parse(req.body);
      const result = await applyInvoiceTotalsRebuild(
        body.scopeType,
        body.scopeId ?? null,
        "manual",
        body.reason,
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // List recovery runs
  app.get("/api/admin/billing-recovery/runs", async (req: Request, res: Response) => {
    try {
      const querySchema = z.object({
        recoveryType: z.string().optional(),
        scopeType: z.string().optional(),
        scopeId: z.string().optional(),
        status: z.string().optional(),
        dryRun: z
          .string()
          .optional()
          .transform((v) => (v === undefined ? undefined : v === "true")),
        limit: z
          .string()
          .optional()
          .transform((v) => (v ? Number(v) : 50)),
        offset: z
          .string()
          .optional()
          .transform((v) => (v ? Number(v) : 0)),
      });
      const query = querySchema.parse(req.query);
      const result = await listRecoveryRuns(query);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Get recovery run detail
  app.get("/api/admin/billing-recovery/runs/:runId", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const detail = await getRecoveryRunDetail(runId);
      if (!detail) {
        return res.status(404).json({ error: "Recovery run not found" });
      }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Explain recovery run
  app.get("/api/admin/billing-recovery/runs/:runId/explain", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const explanation = await explainRecoveryRun(runId);
      if (!explanation) {
        return res.status(404).json({ error: "Recovery run not found" });
      }
      res.json(explanation);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Recovery run stats
  app.get("/api/admin/billing-recovery/runs/stats/summary", async (req: Request, res: Response) => {
    try {
      const windowDays = req.query.windowDays ? Number(String(req.query.windowDays)) : 30;
      const stats = await getRecoveryRunStats(windowDays);
      res.json({ stats, windowDays });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Retention: age report
  app.get("/api/admin/billing-recovery/retention/age-report", async (_req: Request, res: Response) => {
    try {
      const report = await getRecoveryRunAgeReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Retention: action stats
  app.get("/api/admin/billing-recovery/retention/action-stats", async (req: Request, res: Response) => {
    try {
      const windowDays = req.query.windowDays ? Number(String(req.query.windowDays)) : 90;
      const stats = await getRecoveryActionStats(windowDays);
      res.json({ stats, windowDays });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Retention: candidates for archival
  app.get("/api/admin/billing-recovery/retention/candidates/:days", async (req: Request, res: Response) => {
    try {
      const ageDays = Number(String(req.params.days));
      const limit = req.query.limit ? Number(String(req.query.limit)) : 200;
      const candidates = await findRetentionCandidates(ageDays, limit);
      res.json({ candidates, count: candidates.length, ageDays });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Retention: stuck runs
  app.get("/api/admin/billing-recovery/retention/stuck-runs", async (req: Request, res: Response) => {
    try {
      const minutes = req.query.minutes ? Number(String(req.query.minutes)) : 60;
      const stuck = await findStuckRecoveryRuns(minutes);
      res.json({ stuckRuns: stuck, count: stuck.length, thresholdMinutes: minutes });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Retention: daily trend
  app.get("/api/admin/billing-recovery/retention/daily-trend", async (req: Request, res: Response) => {
    try {
      const windowDays = req.query.windowDays ? Number(String(req.query.windowDays)) : 14;
      const trend = await getRecoveryRunDailyTrend(windowDays);
      res.json({ trend, windowDays });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
