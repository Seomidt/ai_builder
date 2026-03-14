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
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { knowledgeAssets, knowledgeAssetVersions } from "@shared/schema";
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

// Phase 5A: Document Registry & Storage Foundation
import {
  createKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  archiveKnowledgeBase,
  createKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  createKnowledgeDocumentVersion,
  getKnowledgeDocumentVersion,
  listKnowledgeDocumentVersions,
  setCurrentDocumentVersion,
  verifyCurrentVersionInvariant,
} from "../lib/ai/knowledge-bases";
import {
  attachStorageObject,
  getStorageObjectsByVersion,
  createKnowledgeProcessingJob,
  getProcessingJob,
  listProcessingJobs,
  getIndexStateByVersion,
  listIndexStateByKnowledgeBase,
  updateKnowledgeIndexState,
  isVersionRetrievable,
  listChunksByVersion,
  runParseForDocumentVersion,
  runChunkingForDocumentVersion,
  previewChunkingForDocumentVersion,
  markParseFailed,
  markParseCompleted,
  explainDocumentVersionParseState,
  explainDocumentVersionChunkState,
  previewChunkReplacement,
  listDocumentProcessingJobs,
  summarizeChunkingResult,
  acquireKnowledgeProcessingJob,
  failKnowledgeProcessingJob,
  runStructuredParseForDocumentVersion,
  runStructuredChunkingForDocumentVersion,
  markStructuredParseFailed,
  markStructuredParseCompleted,
  explainStructuredParseState,
  explainStructuredChunkState,
  previewStructuredChunkReplacement,
  listStructuredProcessingJobs,
  summarizeStructuredChunkingResult,
  syncIndexStateAfterStructuredChunking,
  markIndexStateStaleAfterStructuredChunkReplace,
  runOcrParseForDocumentVersion,
  runOcrChunkingForDocumentVersion,
  markOcrParseFailed,
  markOcrParseCompleted,
  explainOcrParseState,
  explainOcrChunkState,
  previewOcrChunkReplacement,
  listOcrProcessingJobs,
  summarizeOcrChunkingResult,
  syncIndexStateAfterOcrChunking,
  markIndexStateStaleAfterOcrChunkReplace,
  runTranscriptParseForDocumentVersion,
  runTranscriptChunkingForDocumentVersion,
  markTranscriptParseFailed,
  markTranscriptParseCompleted,
  explainTranscriptParseState,
  explainTranscriptChunkState,
  previewTranscriptChunkReplacement,
  listTranscriptProcessingJobs,
  summarizeTranscriptChunkingResult,
  syncIndexStateAfterTranscriptChunking,
  markIndexStateStaleAfterTranscriptChunkReplace,
  runImportParseForDocumentVersion,
  runImportChunkingForDocumentVersion,
  markImportParseFailed,
  markImportParseCompleted,
  explainImportParseState,
  explainImportChunkState,
  previewImportChunkReplacement,
  listImportProcessingJobs,
  summarizeImportChunkingResult,
  syncIndexStateAfterImportChunking,
  markIndexStateStaleAfterImportChunkReplace,
} from "../lib/ai/knowledge-processing";
import {
  runEmbeddingForDocumentVersion,
  retryEmbeddingForDocumentVersion,
  explainEmbeddingState,
  listEmbeddingJobs,
  summarizeEmbeddingResult,
  listEmbeddingsForDocument,
} from "../lib/ai/embedding-processing";
import { selectDocumentParser } from "../lib/ai/document-parsers";
import {
  runVectorSearch,
  explainVectorSearch,
  previewRetrievalSafeFilterSet,
  explainWhyChunkWasExcluded,
  explainWhyChunkWasReturned,
  summarizeVectorSearchRun,
  listVectorSearchCandidates,
  VectorSearchInvariantError,
} from "../lib/ai/vector-search";
import {
  runRetrievalOrchestration,
  explainRetrievalContext,
  buildContextPreview,
  getRetrievalRun,
  RetrievalInvariantError,
} from "../lib/ai/retrieval-orchestrator";
import {
  recordRetrievalMetrics,
  getRetrievalMetricsByRunId,
  getRetrievalMetricsSummary,
} from "../lib/ai/retrieval-metrics";
import {
  hashRetrievalQuery,
  getCachedRetrieval,
  storeCachedRetrieval,
  invalidateRetrievalCacheForKnowledgeBase,
  invalidateRetrievalCacheForDocument,
  previewExpiredRetrievalCache,
} from "../lib/ai/retrieval-cache";
import {
  getCurrentEmbeddingVersion,
  getCurrentRetrievalVersion,
  markKnowledgeBaseForReindex,
  previewStaleEmbeddingDocuments,
  explainEmbeddingVersionState,
} from "../lib/ai/embedding-lifecycle";
import {
  recordDocumentTrustSignal,
  calculateDocumentRiskScore,
  getDocumentTrustSignals,
  getDocumentRiskScore,
  explainDocumentTrust,
} from "../lib/ai/document-trust";
import { getVectorAdapterInfo } from "../lib/ai/vector-adapter";

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

// Phase 5G: Knowledge Asset Registry & Multimodal Foundation
import {
  createKnowledgeAsset,
  createKnowledgeAssetVersion,
  setKnowledgeAssetCurrentVersion,
  getKnowledgeAssetById,
  listKnowledgeAssetsByKnowledgeBase,
  listKnowledgeAssetsByTenant,
  updateKnowledgeAssetLifecycle,
  markKnowledgeAssetProcessingState,
  explainKnowledgeAsset,
} from "../lib/ai/knowledge-assets";
import {
  registerStorageObject,
  getStorageObjectById,
  listStorageObjectsByTenant,
  markStorageObjectArchived,
  markStorageObjectDeleted,
  explainStorageObject,
} from "../lib/ai/knowledge-storage";
import {
  enqueueAssetProcessingJob,
  startAssetProcessingJob,
  completeAssetProcessingJob,
  failAssetProcessingJob,
  listAssetProcessingJobs,
  explainAssetProcessingState,
} from "../lib/ai/knowledge-asset-processing";
import {
  explainDocumentToAssetMigrationStrategy,
  previewLegacyDocumentCompatibility,
  explainCurrentRegistryState,
} from "../lib/ai/knowledge-asset-compat";

// Phase 5I: Asset Processing Engine
import {
  dispatchProcessingBatch,
  getQueueHealthSummary,
} from "../services/asset-processing/asset_processing_dispatcher";
import {
  processAssetJob,
  retryAssetProcessingJob,
  detectOrphanJobs,
  explainJobExecution,
  MAX_ATTEMPTS,
} from "../services/asset-processing/process_asset_job";
import {
  getPipelineForAssetType,
  explainPipeline,
} from "../services/asset-processing/asset_processing_pipeline";
import {
  listRegisteredProcessors,
  loadAllProcessors,
} from "../services/asset-processing/asset_processor_registry";
import {
  enqueueAssetProcessingJob as enqueueAssetJob5I,
  listAssetProcessingJobs as listJobs5I,
  getAssetProcessingJobById,
} from "../lib/ai/knowledge-asset-processing";
import {
  ingestKnowledgeAsset,
  ingestKnowledgeAssetVersion,
  previewKnowledgeAssetIngestion,
  setCurrentAssetVersion,
  explainKnowledgeAssetIngestion,
  listKnowledgeAssetVersions,
  explainAssetProcessingPlan,
} from "../lib/ai/knowledge-asset-ingestion";
import {
  registerKnowledgeStorageObject,
  findKnowledgeStorageObjectByLocation,
  getKnowledgeStorageObjectById,
  previewStorageBinding,
  explainKnowledgeStorageObjectData,
} from "../lib/ai/knowledge-storage";

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

  // ─── Phase 5A: Document Registry & Storage Foundation ───────────────────────

  // Knowledge Bases
  app.post("/api/admin/knowledge-bases", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        tenantId: z.string().min(1),
        name: z.string().min(1),
        slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
        description: z.string().optional(),
        lifecycleState: z.enum(["active", "archived", "deleted"]).optional(),
        visibility: z.enum(["private", "internal"]).optional(),
        defaultRetrievalK: z.number().int().positive().optional(),
        metadata: z.record(z.unknown()).optional(),
        createdBy: z.string().optional(),
      }).parse(req.body);
      const kb = await createKnowledgeBase(body);
      res.status(201).json({ knowledgeBase: kb });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-bases", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const lifecycleState = req.query.lifecycleState ? String(req.query.lifecycleState) : undefined;
      const bases = await listKnowledgeBases(tenantId, lifecycleState);
      res.json({ knowledgeBases: bases, count: bases.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-bases/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const kb = await getKnowledgeBase(id, tenantId);
      if (!kb) return res.status(404).json({ error: "knowledge base not found" });
      res.json({ knowledgeBase: kb });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge-bases/:id/archive", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const body = z.object({ tenantId: z.string().min(1), updatedBy: z.string().optional() }).parse(req.body);
      const kb = await archiveKnowledgeBase(id, body.tenantId, body.updatedBy);
      if (!kb) return res.status(404).json({ error: "knowledge base not found" });
      res.json({ knowledgeBase: kb });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Knowledge Documents
  app.post("/api/admin/knowledge-documents", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        title: z.string().min(1),
        documentType: z.string().optional(),
        sourceType: z.enum(["upload", "api", "manual", "import"]).optional(),
        externalReference: z.string().optional(),
        tags: z.record(z.unknown()).optional(),
        metadata: z.record(z.unknown()).optional(),
        createdBy: z.string().optional(),
      }).parse(req.body);
      const doc = await createKnowledgeDocument(body);
      res.status(201).json({ document: doc });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-documents", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const knowledgeBaseId = req.query.knowledgeBaseId ? String(req.query.knowledgeBaseId) : undefined;
      const documentStatus = req.query.documentStatus ? String(req.query.documentStatus) : undefined;
      const docs = await listKnowledgeDocuments(tenantId, knowledgeBaseId, documentStatus);
      res.json({ documents: docs, count: docs.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-documents/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const doc = await getKnowledgeDocument(id, tenantId);
      if (!doc) return res.status(404).json({ error: "document not found" });
      res.json({ document: doc });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Document Versions
  app.post("/api/admin/knowledge-documents/:documentId/versions", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const body = z.object({
        tenantId: z.string().min(1),
        versionNumber: z.number().int().positive(),
        sourceLabel: z.string().optional(),
        mimeType: z.string().optional(),
        fileSizeBytes: z.number().int().nonnegative().optional(),
        characterCount: z.number().int().nonnegative().optional(),
        pageCount: z.number().int().nonnegative().optional(),
        languageCode: z.string().optional(),
        contentChecksum: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        createdBy: z.string().optional(),
      }).parse(req.body);
      const version = await createKnowledgeDocumentVersion({ ...body, knowledgeDocumentId: documentId });
      res.status(201).json({ version });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-documents/:documentId/versions", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const versions = await listKnowledgeDocumentVersions(documentId, tenantId);
      res.json({ versions, count: versions.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-versions/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const version = await getKnowledgeDocumentVersion(versionId, tenantId);
      if (!version) return res.status(404).json({ error: "version not found" });
      res.json({ version });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge-documents/:documentId/set-current-version", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const body = z.object({ tenantId: z.string().min(1), versionId: z.string().min(1) }).parse(req.body);
      const result = await setCurrentDocumentVersion(documentId, body.versionId, body.tenantId);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-documents/:documentId/version-invariant", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const check = await verifyCurrentVersionInvariant(documentId, tenantId);
      res.json(check);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Storage Objects
  app.post("/api/admin/knowledge-storage-objects", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        tenantId: z.string().min(1),
        knowledgeDocumentVersionId: z.string().min(1),
        storageProvider: z.enum(["r2", "supabase_storage", "local"]),
        objectKey: z.string().min(1),
        bucketName: z.string().optional(),
        originalFilename: z.string().optional(),
        mimeType: z.string().optional(),
        fileSizeBytes: z.number().int().nonnegative().optional(),
        checksum: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }).parse(req.body);
      const obj = await attachStorageObject(body);
      res.status(201).json({ storageObject: obj });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-versions/:versionId/storage-objects", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const objects = await getStorageObjectsByVersion(versionId, tenantId);
      res.json({ storageObjects: objects, count: objects.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Processing Jobs
  app.post("/api/admin/knowledge-processing-jobs", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        tenantId: z.string().min(1),
        knowledgeDocumentId: z.string().min(1),
        knowledgeDocumentVersionId: z.string().optional(),
        jobType: z.enum(["upload_verify", "parse", "chunk", "embed", "index", "reindex", "delete_index", "lifecycle_sync"]),
        priority: z.number().int().nonnegative().optional(),
        maxAttempts: z.number().int().positive().optional(),
        idempotencyKey: z.string().optional(),
        payload: z.record(z.unknown()).optional(),
        workerId: z.string().optional(),
      }).parse(req.body);
      const job = await createKnowledgeProcessingJob(body);
      res.status(201).json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-processing-jobs", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const documentId = req.query.documentId ? String(req.query.documentId) : undefined;
      const status = req.query.status ? String(req.query.status) : undefined;
      const jobs = await listProcessingJobs(tenantId, documentId, status);
      res.json({ jobs, count: jobs.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-processing-jobs/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const job = await getProcessingJob(id, tenantId);
      if (!job) return res.status(404).json({ error: "processing job not found" });
      res.json({ job });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Index State
  app.get("/api/admin/knowledge-index-state/by-version/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await getIndexStateByVersion(versionId, tenantId);
      if (!state) return res.status(404).json({ error: "index state not found" });
      const retrievable = await isVersionRetrievable(versionId, tenantId);
      res.json({ indexState: state, retrievable });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge-index-state", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      const knowledgeBaseId = String(req.query.knowledgeBaseId ?? "");
      if (!tenantId || !knowledgeBaseId) return res.status(400).json({ error: "tenantId and knowledgeBaseId required" });
      const indexStateFilter = req.query.indexState ? String(req.query.indexState) : undefined;
      const states = await listIndexStateByKnowledgeBase(knowledgeBaseId, tenantId, indexStateFilter);
      res.json({ indexStates: states, count: states.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge-index-state", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        knowledgeDocumentId: z.string().min(1),
        knowledgeDocumentVersionId: z.string().min(1),
        indexState: z.enum(["pending", "indexing", "indexed", "failed", "stale", "deleted"]),
        chunkCount: z.number().int().nonnegative().optional(),
        indexedChunkCount: z.number().int().nonnegative().optional(),
        embeddingCount: z.number().int().nonnegative().optional(),
        staleReason: z.string().optional(),
        failureReason: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }).parse(req.body);
      const state = await updateKnowledgeIndexState(body);
      res.json({ indexState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Vector adapter info
  app.get("/api/admin/knowledge-vector-adapter/info", async (_req: Request, res: Response) => {
    try {
      const info = getVectorAdapterInfo();
      res.json({ vectorAdapter: info });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B: Parse Routes ─────────────────────────────────────────────────

  app.post("/api/admin/knowledge/parse/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().optional(),
        documentType: z.string().optional(),
        workerId: z.string().optional(),
        idempotencyKey: z.string().optional(),
        processorName: z.string().optional(),
        processorVersion: z.string().optional(),
      }).parse(req.body);
      const result = await runParseForDocumentVersion(body.versionId, body.tenantId, body);
      res.json({ parseResult: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/parse/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const explanation = await explainDocumentVersionParseState(versionId, tenantId);
      res.json({ parseState: explanation });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/parse/mark-failed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().min(1),
      }).parse(req.body);
      await markParseFailed(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/parse/mark-completed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        parserName: z.string().min(1),
        parserVersion: z.string().min(1),
        parsedTextChecksum: z.string().min(1),
        normalizedCharacterCount: z.number().int().nonnegative(),
      }).parse(req.body);
      await markParseCompleted(body.versionId, body.tenantId, body);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/parse/select-parser", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        mimeType: z.string().min(1),
        documentType: z.string().optional(),
      }).parse(req.body);
      const descriptor = selectDocumentParser(body.mimeType, body.documentType);
      res.json({ parser: descriptor });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B: Chunk Routes ──────────────────────────────────────────────────

  app.post("/api/admin/knowledge/chunk/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().optional(),
        chunkingConfig: z.object({
          maxCharacters: z.number().int().positive().optional(),
          overlapCharacters: z.number().int().nonnegative().optional(),
          strategy: z.string().optional(),
          strategyVersion: z.string().optional(),
        }).optional(),
        workerId: z.string().optional(),
        idempotencyKey: z.string().optional(),
        processorName: z.string().optional(),
        processorVersion: z.string().optional(),
      }).parse(req.body);
      const result = await runChunkingForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        chunkingConfig: body.chunkingConfig,
        workerId: body.workerId,
        idempotencyKey: body.idempotencyKey,
        processorName: body.processorName,
        processorVersion: body.processorVersion,
      });
      res.json({ chunkingResult: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/chunk/preview", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().min(1),
        mimeType: z.string().optional(),
        documentType: z.string().optional(),
        chunkingConfig: z.object({
          maxCharacters: z.number().int().positive().optional(),
          overlapCharacters: z.number().int().nonnegative().optional(),
          strategy: z.string().optional(),
          strategyVersion: z.string().optional(),
        }).optional(),
      }).parse(req.body);
      const preview = await previewChunkingForDocumentVersion(
        body.versionId,
        body.tenantId,
        body.content,
        { chunkingConfig: body.chunkingConfig, mimeType: body.mimeType, documentType: body.documentType },
      );
      res.json({ chunkPreview: preview });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/chunk/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const explanation = await explainDocumentVersionChunkState(versionId, tenantId);
      res.json({ chunkState: explanation });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/chunk/preview-replacement/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const preview = await previewChunkReplacement(versionId, tenantId);
      res.json({ replacementPreview: preview });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/chunk/list/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      const activeOnly = req.query.activeOnly !== "false";
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const chunks = await listChunksByVersion(versionId, tenantId, activeOnly);
      res.json({ chunks, count: chunks.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B: Job Routes ────────────────────────────────────────────────────

  app.get("/api/admin/knowledge/jobs/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      const jobType = req.query.jobType ? String(req.query.jobType) : undefined;
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const jobs = await listDocumentProcessingJobs(documentId, tenantId, jobType);
      res.json({ jobs, count: jobs.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/jobs/summary/:jobId", async (req: Request, res: Response) => {
    try {
      const jobId = String(req.params.jobId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const summary = await summarizeChunkingResult(jobId, tenantId);
      res.json({ jobSummary: summary });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/jobs/acquire", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        jobId: z.string().min(1),
        tenantId: z.string().min(1),
        workerId: z.string().optional(),
        processorName: z.string().optional(),
        processorVersion: z.string().optional(),
      }).parse(req.body);
      const job = await acquireKnowledgeProcessingJob(body.jobId, body.tenantId, {
        workerId: body.workerId,
        processorName: body.processorName,
        processorVersion: body.processorVersion,
      });
      if (!job) {
        return res.status(409).json({ error: "Job could not be acquired — already running or completed." });
      }
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/jobs/fail", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        jobId: z.string().min(1),
        tenantId: z.string().min(1),
        failureReason: z.string().min(1),
      }).parse(req.body);
      const job = await failKnowledgeProcessingJob(body.jobId, body.tenantId, body.failureReason);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B: Version Inspection Routes ────────────────────────────────────

  app.get("/api/admin/knowledge/versions/:versionId/parse-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainDocumentVersionParseState(versionId, tenantId);
      res.json({ parseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/chunk-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainDocumentVersionChunkState(versionId, tenantId);
      res.json({ chunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/index-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const idxState = await getIndexStateByVersion(versionId, tenantId);
      const retrievable = await isVersionRetrievable(versionId, tenantId);
      res.json({ indexState: idxState, retrievable });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B.1: Structured Parse Routes ────────────────────────────────────

  app.post("/api/admin/knowledge/structured/parse/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().min(1),
        workerId: z.string().optional(),
        idempotencyKey: z.string().optional(),
        parseOptions: z.object({
          sheetName: z.string().optional(),
          hasHeader: z.boolean().optional(),
          delimiter: z.string().optional(),
          maxRows: z.number().int().positive().optional(),
        }).optional(),
      }).parse(req.body);
      const result = await runStructuredParseForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        workerId: body.workerId,
        idempotencyKey: body.idempotencyKey,
        parseOptions: body.parseOptions,
      });
      res.json({ result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/structured/parse/mark-failed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().min(1),
      }).parse(req.body);
      await markStructuredParseFailed(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/structured/parse/mark-completed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        sheetCount: z.number().int().min(0),
        rowCount: z.number().int().min(0),
        columnCount: z.number().int().min(0),
        contentChecksum: z.string().min(1),
      }).parse(req.body);
      await markStructuredParseCompleted(body.versionId, body.tenantId, {
        sheetCount: body.sheetCount,
        rowCount: body.rowCount,
        columnCount: body.columnCount,
        contentChecksum: body.contentChecksum,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/structured/parse/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainStructuredParseState(versionId, tenantId);
      res.json({ structuredParseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B.1: Structured Chunk Routes ────────────────────────────────────

  app.post("/api/admin/knowledge/structured/chunk/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().optional(),
        workerId: z.string().optional(),
        idempotencyKey: z.string().optional(),
        chunkingConfig: z.object({
          strategy: z.string().optional(),
          version: z.string().optional(),
          rowWindowSize: z.number().int().positive().optional(),
          includeHeaders: z.boolean().optional(),
        }).optional(),
      }).parse(req.body);
      const result = await runStructuredChunkingForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        workerId: body.workerId,
        idempotencyKey: body.idempotencyKey,
        chunkingConfig: body.chunkingConfig,
      });
      res.json({ result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/structured/chunk/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainStructuredChunkState(versionId, tenantId);
      res.json({ structuredChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/structured/chunk/preview-replacement/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const preview = await previewStructuredChunkReplacement(versionId, tenantId);
      res.json({ preview });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/structured/chunk/list/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const chunks = await listChunksByVersion(versionId, tenantId, false);
      const tableChunks = chunks.filter((c) => (c as Record<string, unknown>).tableChunk === true);
      res.json({ chunks: tableChunks, total: tableChunks.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B.1: Structured Jobs & Inspection Routes ─────────────────────────

  app.get("/api/admin/knowledge/structured/jobs/document/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const jobs = await listStructuredProcessingJobs(documentId, tenantId);
      res.json({ jobs, total: jobs.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/structured/jobs/:jobId/summarize", async (req: Request, res: Response) => {
    try {
      const jobId = String(req.params.jobId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const summary = await summarizeStructuredChunkingResult(jobId, tenantId);
      res.json({ summary });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/structured-parse-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainStructuredParseState(versionId, tenantId);
      res.json({ structuredParseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/structured-chunk-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainStructuredChunkState(versionId, tenantId);
      res.json({ structuredChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/structured/index-state/sync", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        knowledgeDocumentId: z.string().min(1),
        chunkCount: z.number().int().min(0),
      }).parse(req.body);
      const row = await syncIndexStateAfterStructuredChunking(
        body.versionId,
        body.tenantId,
        body.knowledgeBaseId,
        body.knowledgeDocumentId,
        body.chunkCount,
      );
      res.json({ indexState: row });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/structured/index-state/mark-stale", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().optional(),
      }).parse(req.body);
      await markIndexStateStaleAfterStructuredChunkReplace(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B.2: Image OCR Parse Routes ─────────────────────────────────────

  app.post("/api/admin/knowledge/image-ocr/parse/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().min(1),
        workerId: z.string().optional(),
        idempotencyKey: z.string().optional(),
        parseOptions: z.object({
          maxImageSizeBytes: z.number().int().positive().optional(),
          engineHint: z.string().optional(),
          contentLabel: z.string().optional(),
        }).optional(),
      }).parse(req.body);
      const result = await runOcrParseForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        workerId: body.workerId,
        idempotencyKey: body.idempotencyKey,
        parseOptions: body.parseOptions,
      });
      res.json({ result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/image-ocr/parse/mark-failed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().min(1),
      }).parse(req.body);
      await markOcrParseFailed(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/image-ocr/parse/mark-completed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        blockCount: z.number().int().min(0),
        lineCount: z.number().int().min(0),
        averageConfidence: z.number().min(0).max(1),
        textChecksum: z.string().min(1),
        engineName: z.string().min(1),
        engineVersion: z.string().min(1),
      }).parse(req.body);
      await markOcrParseCompleted(body.versionId, body.tenantId, {
        blockCount: body.blockCount,
        lineCount: body.lineCount,
        averageConfidence: body.averageConfidence,
        textChecksum: body.textChecksum,
        engineName: body.engineName,
        engineVersion: body.engineVersion,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/image-ocr/parse/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainOcrParseState(versionId, tenantId);
      res.json({ ocrParseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B.2: Image OCR Chunk Routes ─────────────────────────────────────

  app.post("/api/admin/knowledge/image-ocr/chunk/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().optional(),
        workerId: z.string().optional(),
        idempotencyKey: z.string().optional(),
        chunkingConfig: z.object({
          strategy: z.string().optional(),
          version: z.string().optional(),
          regionWindowSize: z.number().int().positive().optional(),
          includeRegionMetadata: z.boolean().optional(),
        }).optional(),
      }).parse(req.body);
      const result = await runOcrChunkingForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        workerId: body.workerId,
        idempotencyKey: body.idempotencyKey,
        chunkingConfig: body.chunkingConfig,
      });
      res.json({ result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/image-ocr/chunk/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainOcrChunkState(versionId, tenantId);
      res.json({ ocrChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/image-ocr/chunk/preview-replacement/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const preview = await previewOcrChunkReplacement(versionId, tenantId);
      res.json({ preview });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/image-ocr/chunk/list/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const chunks = await listChunksByVersion(versionId, tenantId, false);
      const imageChunks = chunks.filter((c) => (c as Record<string, unknown>).imageChunk === true);
      res.json({ chunks: imageChunks, total: imageChunks.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B.2: OCR Jobs & Inspection Routes ────────────────────────────────

  app.get("/api/admin/knowledge/image-ocr/jobs/document/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const jobs = await listOcrProcessingJobs(documentId, tenantId);
      res.json({ jobs, total: jobs.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/image-ocr/jobs/:jobId/summarize", async (req: Request, res: Response) => {
    try {
      const jobId = String(req.params.jobId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const summary = await summarizeOcrChunkingResult(jobId, tenantId);
      res.json({ summary });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/ocr-parse-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainOcrParseState(versionId, tenantId);
      res.json({ ocrParseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/ocr-chunk-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainOcrChunkState(versionId, tenantId);
      res.json({ ocrChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/image-ocr/index-state/sync", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        knowledgeDocumentId: z.string().min(1),
        chunkCount: z.number().int().min(0),
      }).parse(req.body);
      const row = await syncIndexStateAfterOcrChunking(
        body.versionId,
        body.tenantId,
        body.knowledgeBaseId,
        body.knowledgeDocumentId,
        body.chunkCount,
      );
      res.json({ indexState: row });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/image-ocr/index-state/mark-stale", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().optional(),
      }).parse(req.body);
      await markIndexStateStaleAfterOcrChunkReplace(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B.3: Media Transcript Admin Routes ─────────────────────────────

  app.post("/api/admin/knowledge/media-transcript/parse/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().optional(),
        idempotencyKey: z.string().optional(),
        workerId: z.string().optional(),
      }).parse(req.body);
      const result = await runTranscriptParseForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        idempotencyKey: body.idempotencyKey,
        workerId: body.workerId,
      });
      res.json({ transcriptParse: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/media-transcript/parse/mark-failed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().min(1),
      }).parse(req.body);
      await markTranscriptParseFailed(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/media-transcript/parse/mark-completed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        segmentCount: z.number().int().min(0),
        speakerCount: z.number().int().min(0),
        durationMs: z.number().int().min(0),
        averageConfidence: z.number().min(0).max(1),
        textChecksum: z.string().min(1),
        languageCode: z.string().min(1),
        engineName: z.string().min(1),
        engineVersion: z.string().min(1),
      }).parse(req.body);
      await markTranscriptParseCompleted(body.versionId, body.tenantId, {
        segmentCount: body.segmentCount,
        speakerCount: body.speakerCount,
        durationMs: body.durationMs,
        averageConfidence: body.averageConfidence,
        textChecksum: body.textChecksum,
        languageCode: body.languageCode,
        engineName: body.engineName,
        engineVersion: body.engineVersion,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/media-transcript/parse/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainTranscriptParseState(versionId, tenantId);
      res.json({ transcriptParseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/media-transcript/chunk/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().optional(),
        idempotencyKey: z.string().optional(),
        workerId: z.string().optional(),
        chunkingConfig: z.object({
          strategy: z.string().optional(),
          version: z.string().optional(),
          windowMs: z.number().int().optional(),
          segmentWindowSize: z.number().int().optional(),
          includeTimestamps: z.boolean().optional(),
          includeSpeakerLabel: z.boolean().optional(),
        }).optional(),
      }).parse(req.body);
      const result = await runTranscriptChunkingForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        idempotencyKey: body.idempotencyKey,
        workerId: body.workerId,
        chunkingConfig: body.chunkingConfig,
      });
      res.json({ transcriptChunk: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/media-transcript/chunk/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainTranscriptChunkState(versionId, tenantId);
      res.json({ transcriptChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/media-transcript/chunk/preview-replacement/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const preview = await previewTranscriptChunkReplacement(versionId, tenantId);
      res.json({ preview });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/media-transcript/chunk/list/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainTranscriptChunkState(versionId, tenantId);
      res.json({ transcriptChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/media-transcript/jobs/document/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const jobs = await listTranscriptProcessingJobs(documentId, tenantId);
      res.json({ jobs });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/media-transcript/jobs/:jobId/summarize", async (req: Request, res: Response) => {
    try {
      const jobId = String(req.params.jobId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const summary = await summarizeTranscriptChunkingResult(jobId, tenantId);
      res.json({ summary });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/media-transcript/index-state/sync", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        knowledgeDocumentId: z.string().min(1),
        chunkCount: z.number().int().min(0),
      }).parse(req.body);
      const row = await syncIndexStateAfterTranscriptChunking(
        body.versionId,
        body.tenantId,
        body.knowledgeBaseId,
        body.knowledgeDocumentId,
        body.chunkCount,
      );
      res.json({ indexState: row });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/media-transcript/index-state/mark-stale", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().optional(),
      }).parse(req.body);
      await markIndexStateStaleAfterTranscriptChunkReplace(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/transcript-parse-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainTranscriptParseState(versionId, tenantId);
      res.json({ transcriptParseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/transcript-chunk-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainTranscriptChunkState(versionId, tenantId);
      res.json({ transcriptChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5B.4: Email / HTML / Imported Content Admin Routes ─────────────

  app.post("/api/admin/knowledge/import-content/parse/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().optional(),
        idempotencyKey: z.string().optional(),
        workerId: z.string().optional(),
        parseOptions: z.object({
          parserHint: z.string().optional(),
          languageHint: z.string().optional(),
          includeQuotedContent: z.boolean().optional(),
          contentLabel: z.string().optional(),
        }).optional(),
      }).parse(req.body);
      const result = await runImportParseForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        idempotencyKey: body.idempotencyKey,
        workerId: body.workerId,
        parseOptions: body.parseOptions,
      });
      res.json({ importParse: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/import-content/parse/mark-failed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().min(1),
      }).parse(req.body);
      await markImportParseFailed(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/import-content/parse/mark-completed", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        contentType: z.enum(["email", "html", "imported_text"]),
        parserName: z.string().min(1),
        parserVersion: z.string().min(1),
        textChecksum: z.string().min(1),
        messageCount: z.number().int().min(0),
        sectionCount: z.number().int().min(0),
        linkCount: z.number().int().min(0),
        sourceLanguageCode: z.string().optional(),
      }).parse(req.body);
      await markImportParseCompleted(body.versionId, body.tenantId, {
        contentType: body.contentType,
        parserName: body.parserName,
        parserVersion: body.parserVersion,
        textChecksum: body.textChecksum,
        messageCount: body.messageCount,
        sectionCount: body.sectionCount,
        linkCount: body.linkCount,
        sourceLanguageCode: body.sourceLanguageCode,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/import-content/parse/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainImportParseState(versionId, tenantId);
      res.json({ importParseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/import-content/chunk/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        content: z.string().optional(),
        idempotencyKey: z.string().optional(),
        workerId: z.string().optional(),
        chunkingConfig: z.object({
          strategy: z.string().optional(),
          version: z.string().optional(),
          maxBlockSize: z.number().int().optional(),
          includeHeaderContext: z.boolean().optional(),
          includeSectionLabel: z.boolean().optional(),
        }).optional(),
      }).parse(req.body);
      const result = await runImportChunkingForDocumentVersion(body.versionId, body.tenantId, {
        content: body.content,
        idempotencyKey: body.idempotencyKey,
        workerId: body.workerId,
        chunkingConfig: body.chunkingConfig,
      });
      res.json({ importChunk: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/import-content/chunk/explain/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainImportChunkState(versionId, tenantId);
      res.json({ importChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/import-content/chunk/preview-replacement/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const preview = await previewImportChunkReplacement(versionId, tenantId);
      res.json({ preview });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/import-content/jobs/document/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const jobs = await listImportProcessingJobs(documentId, tenantId);
      res.json({ jobs });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/import-content/jobs/:jobId/summarize", async (req: Request, res: Response) => {
    try {
      const jobId = String(req.params.jobId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const summary = await summarizeImportChunkingResult(jobId, tenantId);
      res.json({ summary });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/import-content/index-state/sync", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        knowledgeDocumentId: z.string().min(1),
        chunkCount: z.number().int().min(0),
      }).parse(req.body);
      const row = await syncIndexStateAfterImportChunking(
        body.versionId,
        body.tenantId,
        body.knowledgeBaseId,
        body.knowledgeDocumentId,
        body.chunkCount,
      );
      res.json({ indexState: row });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/import-content/index-state/mark-stale", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        reason: z.string().optional(),
      }).parse(req.body);
      await markIndexStateStaleAfterImportChunkReplace(body.versionId, body.tenantId, body.reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/import-parse-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainImportParseState(versionId, tenantId);
      res.json({ importParseState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/import-chunk-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainImportChunkState(versionId, tenantId);
      res.json({ importChunkState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5C: Embedding Pipeline Admin Routes ─────────────────────────────

  app.post("/api/admin/knowledge/embeddings/run", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        providerName: z.string().optional(),
        batchSize: z.number().int().min(1).max(500).optional(),
        workerId: z.string().optional(),
        idempotencyKey: z.string().optional(),
        replaceExisting: z.boolean().optional(),
      }).parse(req.body);
      const result = await runEmbeddingForDocumentVersion(body.versionId, body.tenantId, {
        providerName: body.providerName as any,
        batchSize: body.batchSize,
        workerId: body.workerId,
        idempotencyKey: body.idempotencyKey,
        replaceExisting: body.replaceExisting,
      });
      res.json({ embedding: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/embeddings/retry", async (req: Request, res: Response) => {
    try {
      const body = z.object({
        versionId: z.string().min(1),
        tenantId: z.string().min(1),
        providerName: z.string().optional(),
        batchSize: z.number().int().min(1).max(500).optional(),
        workerId: z.string().optional(),
        idempotencyKey: z.string().optional(),
      }).parse(req.body);
      const result = await retryEmbeddingForDocumentVersion(body.versionId, body.tenantId, {
        providerName: body.providerName as any,
        batchSize: body.batchSize,
        workerId: body.workerId,
        idempotencyKey: body.idempotencyKey,
      });
      res.json({ embedding: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/embeddings/state/:versionId", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainEmbeddingState(versionId, tenantId);
      res.json({ embeddingState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/embeddings/jobs/document/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const jobs = await listEmbeddingJobs(documentId, tenantId);
      res.json({ jobs });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/embeddings/jobs/:jobId/summarize", async (req: Request, res: Response) => {
    try {
      const jobId = String(req.params.jobId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const summary = await summarizeEmbeddingResult(jobId, tenantId);
      res.json({ summary });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/embeddings/document/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const embeddings = await listEmbeddingsForDocument(documentId, tenantId);
      res.json({ embeddings, count: embeddings.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/versions/:versionId/embedding-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const state = await explainEmbeddingState(versionId, tenantId);
      res.json({ embeddingState: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5D: Vector Search Admin Routes ─────────────────────────────────

  const VectorSearchRunSchema = z.object({
    tenantId: z.string().min(1),
    knowledgeBaseId: z.string().min(1),
    queryEmbedding: z.array(z.number()).min(1),
    topK: z.number().int().min(1).max(200).optional(),
    metric: z.enum(["cosine", "l2", "inner_product"]).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    persistDebugRun: z.boolean().optional(),
    embeddingModel: z.string().optional(),
  });

  app.post("/api/admin/knowledge/vector-search/run", async (req: Request, res: Response) => {
    try {
      const parsed = VectorSearchRunSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const results = await runVectorSearch(parsed.data);
      res.json(results);
    } catch (err) {
      const status = err instanceof VectorSearchInvariantError ? 400 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/vector-search/explain", async (req: Request, res: Response) => {
    try {
      const parsed = VectorSearchRunSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const explanation = await explainVectorSearch(parsed.data);
      res.json({ explanation });
    } catch (err) {
      const status = err instanceof VectorSearchInvariantError ? 400 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/vector-search/filter-preview", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      const knowledgeBaseId = String(req.query.knowledgeBaseId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      if (!knowledgeBaseId) return res.status(400).json({ error: "knowledgeBaseId required" });
      const topK = req.query.topK ? Number(req.query.topK) : 10;
      const metric = (req.query.metric as "cosine" | "l2" | "inner_product") ?? "cosine";
      const filters = previewRetrievalSafeFilterSet({ tenantId, knowledgeBaseId, topK, metric });
      res.json({ filters });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/vector-search/run/:runId", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const summary = await summarizeVectorSearchRun(runId, tenantId);
      res.json({ searchRun: summary });
    } catch (err) {
      const status = err instanceof VectorSearchInvariantError ? 400 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/vector-search/candidates/:runId", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const candidates = await listVectorSearchCandidates(runId, tenantId);
      res.json({ candidates, count: candidates.length });
    } catch (err) {
      const status = err instanceof VectorSearchInvariantError ? 400 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/vector-search/chunk-explain/:chunkId", async (req: Request, res: Response) => {
    try {
      const chunkId = String(req.params.chunkId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const explanation = await explainWhyChunkWasExcluded(chunkId, tenantId);
      res.json({ explanation });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5E: Retrieval Orchestration Admin Routes ───────────────────────

  const RetrievalRunSchema = z.object({
    tenantId: z.string().min(1),
    knowledgeBaseId: z.string().min(1),
    queryEmbedding: z.array(z.number()).min(1),
    topKCandidates: z.number().int().min(1).max(200).optional(),
    maxContextTokens: z.number().int().min(100).max(128000).optional(),
    persistRun: z.boolean().optional(),
    embeddingModel: z.string().optional(),
    debugSearchRun: z.boolean().optional(),
    rankingOptions: z.object({
      similarityThreshold: z.number().min(0).max(1).optional(),
      duplicateSimilarityThreshold: z.number().min(0).max(1).optional(),
      groupByDocument: z.boolean().optional(),
      maxChunksPerDocument: z.number().int().min(1).optional(),
    }).optional(),
    contextOptions: z.object({
      maxTokens: z.number().int().min(100).optional(),
      format: z.enum(["plain", "cited"]).optional(),
      includeCitations: z.boolean().optional(),
      deduplicateByContentHash: z.boolean().optional(),
    }).optional(),
  });

  app.post("/api/admin/knowledge/retrieval/run", async (req: Request, res: Response) => {
    try {
      const parsed = RetrievalRunSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const result = await runRetrievalOrchestration(parsed.data);
      res.json(result);
    } catch (err) {
      const status = err instanceof RetrievalInvariantError || err instanceof VectorSearchInvariantError ? 400 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/retrieval/explain", async (req: Request, res: Response) => {
    try {
      const parsed = RetrievalRunSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const explanation = await explainRetrievalContext(parsed.data);
      res.json({ explanation });
    } catch (err) {
      const status = err instanceof RetrievalInvariantError || err instanceof VectorSearchInvariantError ? 400 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/retrieval/context-preview", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        candidates: z.array(z.object({
          rank: z.number(),
          chunkId: z.string(),
          documentId: z.string(),
          documentVersionId: z.string(),
          knowledgeBaseId: z.string(),
          chunkText: z.string().nullable(),
          chunkIndex: z.number(),
          chunkKey: z.string(),
          sourcePageStart: z.number().nullable(),
          sourceHeadingPath: z.string().nullable(),
          similarityScore: z.number(),
          similarityMetric: z.string(),
          contentHash: z.string().nullable(),
        })),
        maxContextTokens: z.number().int().min(100).max(128000).optional(),
        rankingOptions: z.object({
          similarityThreshold: z.number().min(0).max(1).optional(),
          duplicateSimilarityThreshold: z.number().min(0).max(1).optional(),
          groupByDocument: z.boolean().optional(),
        }).optional(),
        contextOptions: z.object({
          format: z.enum(["plain", "cited"]).optional(),
          includeCitations: z.boolean().optional(),
        }).optional(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

      const { contextWindow, summary } = buildContextPreview(
        parsed.data.candidates as any,
        {
          maxContextTokens: parsed.data.maxContextTokens,
          rankingOptions: parsed.data.rankingOptions,
          contextOptions: parsed.data.contextOptions,
        },
      );
      res.json({ contextWindow, summary });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/retrieval/run/:runId", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const run = await getRetrievalRun(runId, tenantId);
      res.json({ retrievalRun: run });
    } catch (err) {
      const status = err instanceof RetrievalInvariantError ? 400 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5F: Retrieval Quality, Cache & Trust Admin Routes ──────────────

  // Retrieval metrics
  app.post("/api/admin/knowledge/retrieval-metrics/record", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        retrievalRunId: z.string().min(1),
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        contextWindow: z.object({
          entries: z.array(z.object({
            text: z.string(),
            metadata: z.object({
              rank: z.number(),
              chunkId: z.string(),
              documentId: z.string(),
              documentVersionId: z.string(),
              knowledgeBaseId: z.string(),
              chunkIndex: z.number(),
              chunkKey: z.string(),
              sourcePageStart: z.number().nullable(),
              sourceHeadingPath: z.string().nullable(),
              similarityScore: z.number(),
              similarityMetric: z.string(),
              contentHash: z.string().nullable(),
              estimatedTokens: z.number(),
            }),
          })),
          totalEstimatedTokens: z.number(),
          budgetRemaining: z.number(),
          budgetUtilizationPct: z.number(),
          chunksSelected: z.number(),
          chunksSkippedBudget: z.number(),
          chunksSkippedDuplicate: z.number(),
          documentCount: z.number(),
          documentIds: z.array(z.string()),
          assembledText: z.string(),
          assemblyFormat: z.enum(["plain", "cited"]),
        }),
        dedupRemovedCount: z.number().int().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const result = await recordRetrievalMetrics(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/retrieval-metrics/:runId", async (req: Request, res: Response) => {
    try {
      const metrics = await getRetrievalMetricsByRunId(String(req.params.runId));
      if (!metrics) return res.status(404).json({ error: "Metrics not found" });
      res.json({ metrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/retrieval-metrics/summary", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const knowledgeBaseId = req.query.knowledgeBaseId ? String(req.query.knowledgeBaseId) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;
      const summary = await getRetrievalMetricsSummary({ tenantId, knowledgeBaseId, limit });
      res.json({ summary });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Retrieval cache
  app.get("/api/admin/knowledge/retrieval-cache/lookup", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      const knowledgeBaseId = String(req.query.knowledgeBaseId ?? "");
      const queryText = String(req.query.queryText ?? "");
      if (!tenantId || !knowledgeBaseId || !queryText) {
        return res.status(400).json({ error: "tenantId, knowledgeBaseId, queryText required" });
      }
      const queryHash = hashRetrievalQuery(queryText);
      const hit = await getCachedRetrieval({ tenantId, knowledgeBaseId, queryHash });
      res.json({ hit, queryHash });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/retrieval-cache/store", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        queryText: z.string().min(1),
        resultChunkIds: z.array(z.string()),
        resultSummary: z.record(z.unknown()).optional(),
        embeddingVersion: z.string().optional(),
        ttlSeconds: z.number().int().min(60).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { queryText, ...rest } = parsed.data;
      const queryHash = hashRetrievalQuery(queryText);
      const result = await storeCachedRetrieval({ queryHash, queryText, ...rest });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/retrieval-cache/invalidate-kb", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const result = await invalidateRetrievalCacheForKnowledgeBase(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/retrieval-cache/invalidate-doc", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        documentId: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const result = await invalidateRetrievalCacheForDocument(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/retrieval-cache/expired-preview", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const knowledgeBaseId = req.query.knowledgeBaseId ? String(req.query.knowledgeBaseId) : undefined;
      const preview = await previewExpiredRetrievalCache({ tenantId, knowledgeBaseId });
      res.json(preview);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Embedding version inspection
  app.get("/api/admin/knowledge/embedding-version/info", async (req: Request, res: Response) => {
    res.json({
      currentEmbeddingVersion: getCurrentEmbeddingVersion(),
      currentRetrievalVersion: getCurrentRetrievalVersion(),
    });
  });

  app.get("/api/admin/knowledge/embedding-version/explain", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      const knowledgeBaseId = String(req.query.knowledgeBaseId ?? "");
      if (!tenantId || !knowledgeBaseId) {
        return res.status(400).json({ error: "tenantId and knowledgeBaseId required" });
      }
      const explanation = await explainEmbeddingVersionState({ tenantId, knowledgeBaseId });
      res.json({ explanation });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/embedding-version/stale-preview", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const knowledgeBaseId = req.query.knowledgeBaseId ? String(req.query.knowledgeBaseId) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;
      const stale = await previewStaleEmbeddingDocuments({ tenantId, knowledgeBaseId, limit });
      res.json({ stale });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/embedding-version/mark-reindex", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        tenantId: z.string().min(1),
        knowledgeBaseId: z.string().min(1),
        reason: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const result = await markKnowledgeBaseForReindex(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Document trust signals
  app.post("/api/admin/document-trust/signal", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        tenantId: z.string().min(1),
        documentId: z.string().min(1),
        documentVersionId: z.string().optional(),
        signalType: z.string().min(1),
        signalSource: z.string().min(1),
        confidenceScore: z.number().min(0).max(1),
        rawEvidence: z.record(z.unknown()).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const result = await recordDocumentTrustSignal(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/document-trust/risk-score", async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        tenantId: z.string().min(1),
        documentId: z.string().min(1),
        documentVersionId: z.string().optional(),
        signals: z.array(z.object({
          signalType: z.string(),
          confidenceScore: z.number().min(0).max(1),
        })).min(0),
        scoringVersion: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const result = await calculateDocumentRiskScore(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/document-trust/signals/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const signals = await getDocumentTrustSignals(documentId, tenantId);
      res.json({ signals });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/document-trust/risk-score/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const score = await getDocumentRiskScore(documentId, tenantId);
      res.json({ riskScore: score });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/document-trust/explain/:documentId", async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId);
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const explanation = await explainDocumentTrust(documentId, tenantId);
      res.json({ explanation });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5G: Knowledge Asset Registry & Multimodal Foundation ───────────

  // Asset CRUD
  app.post("/api/admin/knowledge/assets", async (req: Request, res: Response) => {
    try {
      const asset = await createKnowledgeAsset(req.body);
      res.status(201).json({ asset });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/assets/:assetId", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const asset = await getKnowledgeAssetById(String(req.params.assetId), tenantId);
      if (!asset) return res.status(404).json({ error: "Asset not found" });
      res.json({ asset });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/assets/by-kb/:kbId", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const assets = await listKnowledgeAssetsByKnowledgeBase(tenantId, String(req.params.kbId));
      res.json({ assets });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/assets/by-tenant", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const assets = await listKnowledgeAssetsByTenant(tenantId);
      res.json({ assets });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/assets/:assetId/lifecycle", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.body.tenantId ?? "");
      const lifecycleState = String(req.body.lifecycleState ?? "");
      if (!tenantId || !lifecycleState) {
        return res.status(400).json({ error: "tenantId and lifecycleState required" });
      }
      const asset = await updateKnowledgeAssetLifecycle(String(req.params.assetId), tenantId, lifecycleState as any);
      res.json({ asset });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/assets/:assetId/processing-state", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.body.tenantId ?? "");
      const processingState = String(req.body.processingState ?? "");
      if (!tenantId || !processingState) {
        return res.status(400).json({ error: "tenantId and processingState required" });
      }
      const asset = await markKnowledgeAssetProcessingState(String(req.params.assetId), tenantId, processingState as any);
      res.json({ asset });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/assets/:assetId/explain", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const result = await explainKnowledgeAsset(String(req.params.assetId), tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Asset Versions
  app.post("/api/admin/knowledge/asset-versions", async (req: Request, res: Response) => {
    try {
      const version = await createKnowledgeAssetVersion(req.body);
      res.status(201).json({ version });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/assets/:assetId/set-current-version", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.body.tenantId ?? "");
      const versionId = String(req.body.versionId ?? "");
      if (!tenantId || !versionId) {
        return res.status(400).json({ error: "tenantId and versionId required" });
      }
      const asset = await setKnowledgeAssetCurrentVersion(String(req.params.assetId), tenantId, versionId);
      res.json({ asset });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Storage Objects
  app.post("/api/admin/knowledge/storage-objects", async (req: Request, res: Response) => {
    try {
      const obj = await registerStorageObject(req.body);
      res.status(201).json({ storageObject: obj });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/storage-objects/:objectId", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const obj = await getStorageObjectById(String(req.params.objectId), tenantId);
      if (!obj) return res.status(404).json({ error: "Storage object not found" });
      res.json({ storageObject: obj });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/storage-objects/by-tenant", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const objects = await listStorageObjectsByTenant(tenantId);
      res.json({ storageObjects: objects });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/storage-objects/:objectId/archive", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.body.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const obj = await markStorageObjectArchived(String(req.params.objectId), tenantId);
      res.json({ storageObject: obj });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/storage-objects/:objectId/delete", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.body.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const obj = await markStorageObjectDeleted(String(req.params.objectId), tenantId);
      res.json({ storageObject: obj });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/storage-objects/:objectId/explain", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const result = await explainStorageObject(String(req.params.objectId), tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Processing Jobs
  app.post("/api/admin/knowledge/processing-jobs", async (req: Request, res: Response) => {
    try {
      const job = await enqueueAssetProcessingJob(req.body);
      res.status(201).json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/processing-jobs/:jobId/start", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.body.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const job = await startAssetProcessingJob(String(req.params.jobId), tenantId);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/processing-jobs/:jobId/complete", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.body.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const job = await completeAssetProcessingJob(String(req.params.jobId), tenantId, req.body.metadata);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/admin/knowledge/processing-jobs/:jobId/fail", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.body.tenantId ?? "");
      const errorMessage = String(req.body.errorMessage ?? "unspecified error");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const job = await failAssetProcessingJob(String(req.params.jobId), tenantId, errorMessage);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/processing-jobs/by-asset/:assetId", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const jobs = await listAssetProcessingJobs(tenantId, { assetId: String(req.params.assetId) });
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/processing-jobs/:assetId/explain", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const result = await explainAssetProcessingState(tenantId, String(req.params.assetId));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Compatibility / Migration Explain Helpers
  app.get("/api/admin/knowledge/compat/migration-strategy", async (_req: Request, res: Response) => {
    try {
      const result = explainDocumentToAssetMigrationStrategy();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/compat/legacy-preview", async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId ?? "");
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const result = await previewLegacyDocumentCompatibility(tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/admin/knowledge/compat/registry-state", async (_req: Request, res: Response) => {
    try {
      const result = await explainCurrentRegistryState();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5I: Asset Processing Engine ──────────────────────────────────────

  // GET /api/admin/asset-processing/processors — list all registered processors
  app.get("/api/admin/asset-processing/processors", async (_req: Request, res: Response) => {
    try {
      await loadAllProcessors();
      const processors = listRegisteredProcessors();
      res.json({ processors, count: processors.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/asset-processing/pipeline/:assetType — explain pipeline for asset type
  app.get("/api/admin/asset-processing/pipeline/:assetType", async (req: Request, res: Response) => {
    try {
      const { assetType } = req.params as { assetType: string };
      const explanation = explainPipeline(assetType);
      res.json(explanation);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/asset-processing/queue-health — queue health summary
  app.get("/api/admin/asset-processing/queue-health", async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string | undefined;
      const summary = await getQueueHealthSummary(tenantId);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/asset-processing/dispatch — dispatch a processing batch
  app.post("/api/admin/asset-processing/dispatch", async (req: Request, res: Response) => {
    try {
      const { tenantId, batchSize, jobTypes } = req.body as {
        tenantId?: string;
        batchSize?: number;
        jobTypes?: string[];
      };
      const result = await dispatchProcessingBatch({ tenantId, batchSize, jobTypes });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/asset-processing/jobs/:jobId/execute — execute a single job
  app.post("/api/admin/asset-processing/jobs/:jobId/execute", async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const { tenantId } = req.body as { tenantId: string };
      if (!tenantId) {
        return res.status(400).json({ error: "tenantId required" });
      }
      const result = await processAssetJob(jobId, tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/asset-processing/jobs/:jobId/retry — retry a failed job
  app.post("/api/admin/asset-processing/jobs/:jobId/retry", async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const { tenantId } = req.body as { tenantId: string };
      if (!tenantId) {
        return res.status(400).json({ error: "tenantId required" });
      }
      const newJob = await retryAssetProcessingJob(jobId, tenantId);
      res.json(newJob);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/asset-processing/jobs/:jobId/explain — explain job execution state
  app.get("/api/admin/asset-processing/jobs/:jobId/explain", async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const tenantId = req.query.tenantId as string;
      if (!tenantId) {
        return res.status(400).json({ error: "tenantId query param required" });
      }
      const job = await getAssetProcessingJobById(jobId, tenantId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      const explanation = explainJobExecution(job);
      res.json(explanation);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/asset-processing/orphans — detect orphan jobs
  app.get("/api/admin/asset-processing/orphans", async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const timeoutMinutes = req.query.timeoutMinutes
        ? parseInt(req.query.timeoutMinutes as string, 10)
        : 30;
      if (!tenantId) {
        return res.status(400).json({ error: "tenantId query param required" });
      }
      const orphans = await detectOrphanJobs(tenantId, timeoutMinutes);
      res.json({ orphans, count: orphans.length, timeoutMinutes });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/assets/:assetId/processing-jobs — list all jobs for an asset
  app.get("/api/admin/assets/:assetId/processing-jobs", async (req: Request, res: Response) => {
    try {
      const { assetId } = req.params as { assetId: string };
      const tenantId = req.query.tenantId as string;
      if (!tenantId) {
        return res.status(400).json({ error: "tenantId query param required" });
      }
      const jobs = await listJobs5I(tenantId, { assetId });
      res.json({ jobs, count: jobs.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/assets/:assetId/enqueue-processing — enqueue first pipeline job
  app.post("/api/admin/assets/:assetId/enqueue-processing", async (req: Request, res: Response) => {
    try {
      const { assetId } = req.params as { assetId: string };
      const { tenantId, assetType, assetVersionId, jobType } = req.body as {
        tenantId: string;
        assetType?: string;
        assetVersionId?: string;
        jobType?: string;
      };
      if (!tenantId) {
        return res.status(400).json({ error: "tenantId required" });
      }
      const pipeline = getPipelineForAssetType(assetType ?? "document");
      const entryJobType = jobType ?? pipeline.steps[0];
      const job = await enqueueAssetJob5I({
        tenantId,
        assetId,
        assetVersionId: assetVersionId ?? null,
        jobType: entryJobType,
        metadata: { enqueuedVia: "admin-api", assetType: assetType ?? "document" },
      });
      res.status(201).json({ job, pipeline: pipeline.steps });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5J: Asset Ingestion APIs & Storage Finalization ──────────────────

  // POST /api/admin/knowledge/assets/ingest — ingest a new asset
  app.post("/api/admin/knowledge/assets/ingest", async (req: Request, res: Response) => {
    try {
      const {
        tenantId, knowledgeBaseId, assetType, sourceType, title,
        storage, metadata, createdBy, autoSetCurrent, autoEnqueueProcessing,
      } = req.body as {
        tenantId: string; knowledgeBaseId: string; assetType: string;
        sourceType: string; title?: string; storage: any;
        metadata?: Record<string, unknown>; createdBy?: string;
        autoSetCurrent?: boolean; autoEnqueueProcessing?: boolean;
      };
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      if (!knowledgeBaseId) return res.status(400).json({ error: "knowledgeBaseId required" });
      if (!assetType) return res.status(400).json({ error: "assetType required" });
      if (!sourceType) return res.status(400).json({ error: "sourceType required" });
      if (!storage) return res.status(400).json({ error: "storage required" });
      const result = await ingestKnowledgeAsset({
        tenantId, knowledgeBaseId, assetType, sourceType, title,
        storage, metadata, createdBy, autoSetCurrent, autoEnqueueProcessing,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/knowledge/assets/ingest-version — add a new version to existing asset
  app.post("/api/admin/knowledge/assets/ingest-version", async (req: Request, res: Response) => {
    try {
      const {
        tenantId, assetId, storage, metadata, createdBy,
        autoSetCurrent, autoEnqueueProcessing,
      } = req.body as {
        tenantId: string; assetId: string; storage: any;
        metadata?: Record<string, unknown>; createdBy?: string;
        autoSetCurrent?: boolean; autoEnqueueProcessing?: boolean;
      };
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      if (!assetId) return res.status(400).json({ error: "assetId required" });
      if (!storage) return res.status(400).json({ error: "storage required" });
      const result = await ingestKnowledgeAssetVersion({
        tenantId, assetId, storage, metadata, createdBy,
        autoSetCurrent, autoEnqueueProcessing,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/knowledge/assets/ingest-preview — preview ingestion without writes
  app.post("/api/admin/knowledge/assets/ingest-preview", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.body as { tenantId: string };
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const preview = await previewKnowledgeAssetIngestion(req.body);
      res.json(preview);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/knowledge/assets/:assetId/ingestion-explain — explain ingestion state
  app.get("/api/admin/knowledge/assets/:assetId/ingestion-explain", async (req: Request, res: Response) => {
    try {
      const { assetId } = req.params as { assetId: string };
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: "tenantId query param required" });
      const explanation = await explainKnowledgeAssetIngestion(assetId, tenantId);
      res.json(explanation);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/knowledge/assets/:assetId/versions — list all versions for asset
  app.get("/api/admin/knowledge/assets/:assetId/versions", async (req: Request, res: Response) => {
    try {
      const { assetId } = req.params as { assetId: string };
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: "tenantId query param required" });
      const versions = await listKnowledgeAssetVersions(assetId, tenantId);
      res.json({ versions, count: versions.length });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/knowledge/assets/:assetId/set-current-version — safely set current version
  app.post("/api/admin/knowledge/assets/:assetId/set-current-version-v2", async (req: Request, res: Response) => {
    try {
      const { assetId } = req.params as { assetId: string };
      const { tenantId, versionId } = req.body as { tenantId: string; versionId: string };
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      if (!versionId) return res.status(400).json({ error: "versionId required" });
      const updated = await setCurrentAssetVersion(assetId, versionId, tenantId);
      res.json({ asset: updated, currentVersionId: versionId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/knowledge/assets/:assetId/processing-plan — explain pipeline plan
  app.get("/api/admin/knowledge/assets/:assetId/processing-plan", async (req: Request, res: Response) => {
    try {
      const assetType = req.query.assetType as string;
      const mimeType = req.query.mimeType as string | undefined;
      const sourceType = req.query.sourceType as string | undefined;
      if (!assetType) return res.status(400).json({ error: "assetType query param required" });
      const plan = explainAssetProcessingPlan(assetType, mimeType, sourceType);
      res.json(plan);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/knowledge/storage/register — register new storage object
  app.post("/api/admin/knowledge/storage/register", async (req: Request, res: Response) => {
    try {
      const { tenantId, storageProvider, bucketName, objectKey,
        storageClass, sizeBytes, mimeType, checksumSha256, uploadedAt } = req.body as {
        tenantId: string; storageProvider: any; bucketName: string;
        objectKey: string; storageClass?: any; sizeBytes: number;
        mimeType?: string; checksumSha256?: string; uploadedAt?: string;
      };
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const obj = await registerKnowledgeStorageObject({
        tenantId, storageProvider, bucketName, objectKey, storageClass,
        sizeBytes, mimeType, checksumSha256,
        uploadedAt: uploadedAt ? new Date(uploadedAt) : undefined,
      });
      res.status(201).json(obj);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/knowledge/storage/preview-bind — preview binding (no writes)
  app.post("/api/admin/knowledge/storage/preview-bind", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.body as { tenantId: string };
      if (!tenantId) return res.status(400).json({ error: "tenantId required" });
      const preview = await previewStorageBinding(req.body);
      res.json(preview);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/knowledge/storage/:objectId/explain — explain storage object
  app.get("/api/admin/knowledge/storage/:objectId/explain", async (req: Request, res: Response) => {
    try {
      const { objectId } = req.params as { objectId: string };
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: "tenantId query param required" });
      const obj = await getKnowledgeStorageObjectById(objectId, tenantId);
      if (!obj) return res.status(404).json({ error: "Storage object not found" });
      const explanation = explainKnowledgeStorageObjectData(obj);
      res.json(explanation);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5K: Real Multimodal Processor Routes ───────────────────────────────

  // GET /api/admin/asset-processing/processors/:jobType/explain
  // Explain a specific registered processor's capabilities and MIME support
  app.get("/api/admin/asset-processing/processors/:jobType/explain", async (req: Request, res: Response) => {
    try {
      const { jobType } = req.params as { jobType: string };
      const { hasProcessor, listRegisteredProcessors: listProcs } = await import(
        "../services/asset-processing/asset_processor_registry"
      );
      const { SUPPORTED_MIME_TYPES } = await import(
        "../lib/ai/multimodal-processing-utils"
      );
      const { ASSET_PIPELINES } = await import(
        "../services/asset-processing/asset_processing_pipeline"
      );

      if (!hasProcessor(jobType)) {
        return res.status(404).json({ error: `No processor registered for job type: ${jobType}`, registeredTypes: listProcs() });
      }

      const supportedMimes = SUPPORTED_MIME_TYPES[jobType] ?? [];
      const pipelines = Object.entries(ASSET_PIPELINES)
        .filter(([, def]) => def.steps.includes(jobType))
        .map(([assetType, def]) => ({
          assetType,
          position: def.steps.indexOf(jobType) + 1,
          totalSteps: def.steps.length,
          nextStep: def.steps[def.steps.indexOf(jobType) + 1] ?? null,
        }));

      res.json({
        jobType,
        registered: true,
        isRealProcessor: ["ocr_image", "caption_image", "transcribe_audio", "extract_video_metadata", "sample_video_frames"].includes(jobType),
        supportedMimeTypes: supportedMimes,
        usedInPipelines: pipelines,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/asset-processing/assets/:assetId/processor-output
  // Return all processor output metadata from the current version of an asset
  app.get("/api/admin/asset-processing/assets/:assetId/processor-output", async (req: Request, res: Response) => {
    try {
      const { assetId } = req.params as { assetId: string };
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: "tenantId query param required" });

      const asset = await db
        .select()
        .from(knowledgeAssets)
        .where(and(eq(knowledgeAssets.id, assetId), eq(knowledgeAssets.tenantId, tenantId)))
        .limit(1);

      if (!asset[0]) return res.status(404).json({ error: "Asset not found" });

      const currentVersionId = asset[0].currentVersionId;
      if (!currentVersionId) {
        return res.json({ assetId, currentVersionId: null, processorOutputs: {}, message: "No current version set" });
      }

      const version = await db
        .select()
        .from(knowledgeAssetVersions)
        .where(and(eq(knowledgeAssetVersions.id, currentVersionId), eq(knowledgeAssetVersions.tenantId, tenantId)))
        .limit(1);

      if (!version[0]) return res.status(404).json({ error: "Current version not found" });

      const meta = (version[0].metadata ?? {}) as Record<string, unknown>;

      res.json({
        assetId,
        versionId: currentVersionId,
        processorOutputs: {
          ocr: meta.ocr ?? null,
          transcript: meta.transcript ?? null,
          caption: meta.caption ?? null,
          video: meta.video ?? null,
          video_frames: meta.video_frames ?? null,
        },
        parsedText: meta.parsedText ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/asset-processing/assets/:assetId/processing-metadata
  // Full metadata for current version of an asset — including all processor sections
  app.get("/api/admin/asset-processing/assets/:assetId/processing-metadata", async (req: Request, res: Response) => {
    try {
      const { assetId } = req.params as { assetId: string };
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: "tenantId query param required" });

      const asset = await db
        .select()
        .from(knowledgeAssets)
        .where(and(eq(knowledgeAssets.id, assetId), eq(knowledgeAssets.tenantId, tenantId)))
        .limit(1);

      if (!asset[0]) return res.status(404).json({ error: "Asset not found" });

      const versions = await db
        .select()
        .from(knowledgeAssetVersions)
        .where(and(eq(knowledgeAssetVersions.assetId, assetId), eq(knowledgeAssetVersions.tenantId, tenantId)))
        .limit(20);

      const processingJobs = await listAssetProcessingJobs(tenantId, { assetId, limit: 50 });

      res.json({
        assetId,
        assetType: asset[0].assetType,
        processingState: asset[0].processingState,
        currentVersionId: asset[0].currentVersionId,
        versionCount: versions.length,
        versions: versions.map((v) => ({
          id: v.id,
          versionNumber: v.versionNumber,
          ingestStatus: v.ingestStatus,
          mimeType: v.mimeType,
          isActive: v.isActive,
          metadata: v.metadata,
        })),
        processingJobs: processingJobs.map((j) => ({
          id: j.id,
          jobType: j.jobType,
          jobStatus: j.jobStatus,
          attemptNumber: j.attemptNumber,
          errorMessage: j.errorMessage,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/asset-processing/dependencies
  // Report all external dependencies and their availability
  app.get("/api/admin/asset-processing/dependencies", async (_req: Request, res: Response) => {
    try {
      const { explainProcessingEnvironmentCapabilities } = await import(
        "../lib/ai/multimodal-processing-utils"
      );
      const caps = explainProcessingEnvironmentCapabilities();
      const registeredProcessors = listRegisteredProcessors();
      const { ASSET_PIPELINES } = await import(
        "../services/asset-processing/asset_processing_pipeline"
      );

      res.json({
        capabilities: caps,
        registeredProcessors,
        pipelineCount: Object.keys(ASSET_PIPELINES).length,
        pipelines: Object.entries(ASSET_PIPELINES).map(([assetType, def]) => ({
          assetType,
          steps: def.steps,
          description: def.description,
        })),
        dependencies: {
          openai: {
            required_by: ["ocr_image", "caption_image", "transcribe_audio"],
            available: caps.openai.available,
          },
          ffprobe: {
            required_by: ["extract_video_metadata"],
            available: caps.ffprobe.available,
          },
          ffmpeg: {
            required_by: ["sample_video_frames"],
            available: caps.ffmpeg.available,
          },
          local_storage: {
            required_by: ["all multimodal processors"],
            available: caps.localStorage.basePathExists,
            base_path: caps.localStorage.basePath,
          },
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/asset-processing/environment-capabilities
  // Truthful runtime capability detection (INV-MPROC8)
  app.get("/api/admin/asset-processing/environment-capabilities", async (_req: Request, res: Response) => {
    try {
      const { explainProcessingEnvironmentCapabilities } = await import(
        "../lib/ai/multimodal-processing-utils"
      );
      const caps = explainProcessingEnvironmentCapabilities();
      res.json({
        ...caps,
        detectedAt: new Date().toISOString(),
        note: "Capability detection is truthful — no faking of availability (INV-MPROC8)",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
