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
import { eq, and, sql } from "drizzle-orm";
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
import {
  previewGenerateEmbeddingsForAssetVersion,
  generateEmbeddingsForAssetVersion,
  previewReindexAssetVersion,
  markAssetVersionIndexStale,
  explainAssetVersionIndexState,
  listStaleAssetVersions,
  previewEmbeddingRebuildImpact,
  explainWhyAssetVersionIsOrIsNotRetrievalReady,
} from "../lib/ai/multimodal-embedding-lifecycle";
import {
  explainEmbeddingSourcesForAssetVersion,
  summarizeEmbeddingSourceCoverage,
} from "../lib/ai/multimodal-embedding-sources";
import {
  buildRetrievalProvenanceForRun,
  buildChunkProvenance,
  buildAssetVersionLineage,
  explainChunkInclusionInRun,
  explainChunkExclusionFromRun,
  summarizeRetrievalProvenance,
  listContextSourcesForRun,
  summarizeRetrievalRunExplainability,
} from "../lib/ai/retrieval-provenance";
import {
  buildContextWindowProvenance,
  summarizeContextWindowSources,
} from "../lib/ai/context-provenance";
import {
  explainHybridFusion,
  summarizeHybridRetrieval,
  listHybridCandidateSources,
  explainFusionStrategy,
  fuseVectorAndLexicalCandidates,
} from "../lib/ai/hybrid-retrieval";
import {
  explainReranking,
  summarizeRerankingImpact,
  buildHybridRunSummary,
} from "../lib/ai/reranking";
import {
  explainRerankShortlist,
  summarizeShortlistComposition,
  explainAdvancedReranking,
  summarizeAdvancedRerankingImpact,
  listAdvancedRerankCandidates,
  explainFallbackReranking,
  summarizeFallbackUsage,
  summarizeCalibrationFactors,
  summarizeAdvancedRerankMetrics,
  previewAdvancedReranking,
} from "../lib/ai/advanced-reranking";
import { explainAdvancedRerankingProvider } from "../lib/ai/advanced-reranking-provider";
import {
  summarizeAnswerGrounding,
  getAnswerCitations,
  explainAnswerTrace,
  getAnswerContext,
  summarizeRetrievalRuntimeMetrics,
} from "../lib/ai/answer-grounding";
import { describeRetrievalConfig } from "../lib/config/retrieval-config";
import {
  rewriteRetrievalQuery,
  expandRetrievalQuery,
  previewExpandedQuery,
  explainQueryExpansion,
  summarizeQueryRewrite,
  explainQueryRewrite,
} from "../lib/ai/query-rewriting";
import {
  verifyGroundedAnswer,
  previewExtractedClaims,
  summarizeCitationCoverage,
  summarizeAnswerVerificationMetrics,
  getAnswerVerificationMetrics,
  explainAnswerVerification,
  getAnswerVerificationTrace,
  explainVerificationStage,
} from "../lib/ai/answer-verification";
import type { CitationInput } from "../lib/ai/answer-verification";
import {
  buildHallucinationGuardSummary,
  explainHallucinationGuard,
} from "../lib/ai/hallucination-guard";
import {
  decideFinalAnswerPolicy,
  applyAnswerPolicy,
  explainAnswerPolicy,
  previewAnswerPolicy,
} from "../lib/ai/answer-policy";
import {
  computeRetrievalQualitySignals,
  summarizeRetrievalQualitySignals,
  explainRetrievalQuality,
  summarizeRetrievalQualityMetrics,
} from "../lib/ai/retrieval-quality";
import {
  buildRetrievalSafetySummary,
  explainRetrievalSafety,
} from "../lib/ai/retrieval-safety";
import type { SafetyChunkInput } from "../lib/ai/retrieval-safety";
import type { QualityChunkInput } from "../lib/ai/retrieval-quality";
import {
  summarizeRetrievalFeedback,
  explainRetrievalFeedback,
  listWeakRetrievalRuns,
  listWeakPatterns,
  getFeedbackMetrics,
  summarizeTenantTuningSignals,
  summarizeFeedbackMetrics,
  recordFeedbackMetrics,
  evaluateRetrievalRunFeedback,
  explainRerankEffectiveness,
} from "../lib/ai/retrieval-feedback";

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

  // ============================================================
  // Phase 5K.1 — DB Security Inspection Routes (read-only)
  // ============================================================

  // GET /api/admin/db-security/rls-status
  // Returns RLS enabled/disabled status for all public tables
  app.get("/api/admin/db-security/rls-status", async (_req: Request, res: Response) => {
    try {
      const rows = await db.execute(sql`
        SELECT
          c.relname AS table_name,
          c.relrowsecurity AS rls_enabled,
          c.relforcerowsecurity AS rls_forced,
          (SELECT COUNT(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname
      `);
      const enabled = rows.rows.filter((r: any) => r.rls_enabled).length;
      const disabled = rows.rows.filter((r: any) => !r.rls_enabled).length;
      res.json({
        summary: { total: rows.rows.length, rls_enabled: enabled, rls_disabled: disabled },
        tables: rows.rows,
        phase: "5K.1",
        verified_at: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/db-security/table/:tableName/policies
  // Returns all RLS policies for a specific table
  app.get("/api/admin/db-security/table/:tableName/policies", async (req: Request, res: Response) => {
    try {
      const tableName = String(req.params.tableName);
      if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
        return res.status(400).json({ error: "Invalid table name" });
      }
      const policies = await db.execute(sql`
        SELECT policyname, cmd, permissive, roles, qual, with_check
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${tableName}
        ORDER BY policyname
      `);
      const rlsStatus = await db.execute(sql`
        SELECT relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${tableName}
      `);
      res.json({
        table: tableName,
        rls_enabled: rlsStatus.rows[0]?.relrowsecurity ?? false,
        policy_count: policies.rows.length,
        policies: policies.rows,
        inspected_at: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/db-security/functions/search-path
  // Returns search_path status for all custom public schema functions
  app.get("/api/admin/db-security/functions/search-path", async (_req: Request, res: Response) => {
    try {
      const rows = await db.execute(sql`
        SELECT
          p.proname AS function_name,
          p.prokind AS kind,
          CASE WHEN pg_get_functiondef(p.oid) ILIKE '%search_path%' THEN true ELSE false END AS has_search_path,
          CASE WHEN p.proconfig IS NOT NULL AND array_to_string(p.proconfig, ',') ILIKE '%search_path%' THEN true ELSE false END AS search_path_in_config
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind IN ('f','p','w')
          AND p.proname NOT IN (
            SELECT p2.proname FROM pg_proc p2
            JOIN pg_depend d ON d.objid = p2.oid
            JOIN pg_extension e ON e.oid = d.refobjid
            WHERE d.deptype = 'e'
          )
        ORDER BY p.proname
      `);
      res.json({
        custom_functions: rows.rows.length,
        functions: rows.rows,
        note: "Extension-owned functions (vector, btree_gist) excluded — cannot modify extension functions",
        inspected_at: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/db-security/extensions
  // Returns extension schema locations and safety classification
  app.get("/api/admin/db-security/extensions", async (_req: Request, res: Response) => {
    try {
      const rows = await db.execute(sql`
        SELECT extname, extversion, n.nspname AS schema
        FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace
        ORDER BY extname
      `);
      const classified = rows.rows.map((r: any) => {
        let placement: string;
        let classification: string;
        let lint_warning: string | null = null;
        let lint_status: string | null = null;

        if (r.schema !== "public") {
          placement = "correctly_placed";
          classification = `SAFE — installed in non-public schema '${r.schema}'`;
        } else if (r.extname === "vector") {
          placement = "intentionally_exempted";
          classification = "ACCEPTED EXCEPTION (Phase 5K.1.A) — pgvector type/function resolution requires public schema. Moving would break embeddings and retrieval stack. See /api/admin/db-security/exceptions for full record.";
          lint_warning = "extension_in_public_vector";
          lint_status = "accepted_exception — not an unresolved warning";
        } else if (r.extname === "btree_gist") {
          placement = "intentionally_exempted";
          classification = "ACCEPTED EXCEPTION (Phase 5K.1.A) — 5 active GiST/exclusion constraints depend on this location. Moving would require dropping and recreating billing integrity constraints. See /api/admin/db-security/exceptions for full record.";
          lint_warning = "extension_in_public_btree_gist";
          lint_status = "accepted_exception — not an unresolved warning";
        } else {
          placement = "requires_review";
          classification = "REVIEW REQUIRED — in public schema without documented justification";
          lint_warning = "extension_in_public_" + r.extname;
          lint_status = "unresolved";
        }

        return { ...r, placement, classification, lint_warning, lint_status };
      });

      const publicCount = classified.filter((r: any) => r.in_public).length;
      const correctlyPlaced = classified.filter((r: any) => r.placement === "correctly_placed").length;
      const intentionallyExempted = classified.filter((r: any) => r.placement === "intentionally_exempted").length;
      const requiresReview = classified.filter((r: any) => r.placement === "requires_review").length;

      res.json({
        total_extensions: classified.length,
        in_public_schema: publicCount,
        summary: {
          correctly_placed: correctlyPlaced,
          intentionally_exempted: intentionallyExempted,
          requires_review: requiresReview,
          unresolved_warnings: requiresReview,
        },
        extensions: classified,
        inspected_at: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/db-security/exceptions
  // Returns all documented security exceptions with justifications
  app.get("/api/admin/db-security/exceptions", async (_req: Request, res: Response) => {
    try {
      const globalExemptTables = [
        { table: "admin_change_events", justification: "operator audit log — service-role only, no tenant scope" },
        { table: "admin_change_requests", justification: "operator workflow — service-role only" },
        { table: "ai_approvals", justification: "internal approval workflow — operator-scoped" },
        { table: "ai_artifacts", justification: "internal build artifacts — operator-scoped" },
        { table: "ai_model_overrides", justification: "global model config — no tenant scope" },
        { table: "ai_model_pricing", justification: "global pricing reference — no tenant scope" },
        { table: "ai_provider_reconciliation_runs", justification: "global reconciliation — operator-scoped" },
        { table: "ai_runs", justification: "global AI run registry — operator-scoped" },
        { table: "ai_steps", justification: "global AI step registry — operator-scoped" },
        { table: "ai_tool_calls", justification: "global tool call log — operator-scoped" },
        { table: "architecture_agent_configs", justification: "global architecture config" },
        { table: "architecture_capability_configs", justification: "global capability config" },
        { table: "architecture_policy_bindings", justification: "global policy bindings" },
        { table: "architecture_profiles", justification: "global architecture profiles" },
        { table: "architecture_template_bindings", justification: "global template bindings" },
        { table: "architecture_versions", justification: "global architecture versions" },
        { table: "artifact_dependencies", justification: "global artifact dependency graph" },
        { table: "billing_audit_runs", justification: "operator billing audit runs" },
        { table: "billing_job_definitions", justification: "global job definitions" },
        { table: "billing_job_runs", justification: "global job run log" },
        { table: "billing_metrics_snapshots", justification: "global metrics — operator-scoped" },
        { table: "billing_periods", justification: "global billing period reference" },
        { table: "billing_recovery_actions", justification: "operator recovery actions" },
        { table: "billing_recovery_runs", justification: "operator recovery runs" },
        { table: "integrations", justification: "global integrations config" },
        { table: "invoice_line_items", justification: "linked to tenant invoices but accessed via service role" },
        { table: "organization_members", justification: "org membership — service-role only" },
        { table: "organization_secrets", justification: "org secrets — service-role only" },
        { table: "organizations", justification: "org registry — service-role only" },
        { table: "plan_entitlements", justification: "global plan config reference" },
        { table: "profiles", justification: "user profiles — service-role only in current arch" },
        { table: "projects", justification: "project registry — service-role only" },
        { table: "provider_pricing_versions", justification: "global pricing reference" },
        { table: "provider_reconciliation_runs", justification: "global reconciliation runs" },
        { table: "provider_usage_snapshots", justification: "global usage snapshots" },
        { table: "storage_pricing_versions", justification: "global storage pricing" },
        { table: "subscription_plans", justification: "global plan reference — read-only config" },
      ];

      // Structured extension exception records (Phase 5K.1.A)
      const extensionExceptions = [
        {
          warning_code: "extension_in_public",
          object_type: "extension",
          object_name: "vector",
          schema_name: "public",
          decision: "accepted_exception",
          technical_reason: "pgvector installs 305 functions, operators, and type definitions into its schema. All vector column type references, similarity operators (<->, <=>, <#>), and index access methods resolve against the extension schema at query time. Moving to a non-public schema would require every consumer query and column definition to qualify the type, breaking existing embeddings storage and retrieval stack. No compatibility migration path exists without a dedicated rollback-capable maintenance phase.",
          risk_of_change: "HIGH — would break knowledge_embeddings table, all vector similarity queries in retrieval engine, and pgvector index access methods",
          recommended_future_handling: "Only move in a dedicated extension-migration phase with: (1) full compatibility test on a replica, (2) zero-downtime migration plan, (3) tested rollback procedure. Do not move to silence lint warnings.",
          reviewed_in_phase: "5K.1.A",
          exception_code: "INV-RLS8-EXEMPT-vector",
        },
        {
          warning_code: "extension_in_public",
          object_type: "extension",
          object_name: "btree_gist",
          schema_name: "public",
          decision: "accepted_exception",
          technical_reason: "btree_gist provides operator classes used by 5 active GiST exclusion constraints: billing_periods_no_overlap, cpv_no_overlap, ppv_no_overlap, customer_storage_pricing_vers_tenant_id_storage_provider_s_excl, storage_pricing_versions_storage_provider_storage_product__excl. These constraints enforce non-overlapping billing period integrity. Moving the extension would invalidate the operator class references in those constraints, requiring all 5 to be dropped and recreated — a risky operation on live billing data.",
          risk_of_change: "HIGH — would require dropping and recreating 5 active exclusion constraints on billing integrity tables (billing_periods, customer_pricing_versions, provider_pricing_versions, customer_storage_pricing_versions, storage_pricing_versions)",
          recommended_future_handling: "Only move after: (1) auditing all exclusion constraint definitions, (2) testing operator class relocation on a replica, (3) coordinating a maintenance window for constraint recreation. Do not move to silence lint warnings.",
          reviewed_in_phase: "5K.1.A",
          exception_code: "INV-RLS8-EXEMPT-btree_gist",
        },
      ];

      // Supabase lint warnings — exactly 2 remaining, both are accepted exceptions
      const remainingLintWarnings = [
        {
          warning_id: "extension_in_public_vector",
          status: "accepted_exception",
          exception_record: "vector",
          resolution: "Documented accepted exception — reviewed in Phase 5K.1.A. Not an unresolved warning.",
        },
        {
          warning_id: "extension_in_public_btree_gist",
          status: "accepted_exception",
          exception_record: "btree_gist",
          resolution: "Documented accepted exception — reviewed in Phase 5K.1.A. Not an unresolved warning.",
        },
      ];

      res.json({
        global_table_exceptions: {
          count: globalExemptTables.length,
          policy: "RLS enabled, no tenant policies — deny-all for non-service-role connections",
          tables: globalExemptTables,
        },
        extension_exceptions: {
          count: extensionExceptions.length,
          note: "These are not ignored warnings. Each has been explicitly reviewed, technically justified, and accepted. See recommended_future_handling for safe resolution path.",
          records: extensionExceptions,
        },
        function_exceptions: {
          note: "304 extension-owned functions excluded from search_path hardening (owned by vector/btree_gist extensions)",
          custom_functions_hardened: ["check_no_overlapping_tenant_subscriptions"],
        },
        remaining_lint_warnings: {
          count: remainingLintWarnings.length,
          all_resolved_or_accepted: true,
          warnings: remainingLintWarnings,
        },
        documented_at: "Phase 5K.1 / 5K.1.A",
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 5L: Multimodal Embedding Index Lifecycle ─────────────────────────

  // GET /api/admin/embeddings/asset-version/:versionId/sources
  // INV-EMB12: read-only explain endpoint
  app.get("/api/admin/embeddings/asset-version/:versionId/sources", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      if (!versionId) return void res.status(400).json({ error: "versionId required" });
      const result = await explainEmbeddingSourcesForAssetVersion(versionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/embeddings/asset-version/:versionId/preview-generate
  // INV-EMB12: no writes
  app.get("/api/admin/embeddings/asset-version/:versionId/preview-generate", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      if (!versionId) return void res.status(400).json({ error: "versionId required" });
      const result = await previewGenerateEmbeddingsForAssetVersion(versionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/embeddings/asset-version/:versionId/generate
  // INV-EMB1,2,3,4: real embedding generation with full provenance
  app.post("/api/admin/embeddings/asset-version/:versionId/generate", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      if (!versionId) return void res.status(400).json({ error: "versionId required" });
      const result = await generateEmbeddingsForAssetVersion(versionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/embeddings/asset-version/:versionId/index-state
  // INV-EMB12: read-only; explains current and derived lifecycle state
  app.get("/api/admin/embeddings/asset-version/:versionId/index-state", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      if (!versionId) return void res.status(400).json({ error: "versionId required" });
      const result = await explainAssetVersionIndexState(versionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/admin/embeddings/asset-version/:versionId/mark-stale
  // INV-EMB5,7: marks version + embeddings stale with explicit reason
  app.post("/api/admin/embeddings/asset-version/:versionId/mark-stale", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      const schema = z.object({ reason: z.string().min(1).max(500) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: parsed.error.message });
      await markAssetVersionIndexStale(versionId, parsed.data.reason);
      res.json({ ok: true, assetVersionId: versionId, reason: parsed.data.reason });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/embeddings/asset-version/:versionId/stale-reasons
  // INV-EMB5,12: explain stale detection result — no writes
  app.get("/api/admin/embeddings/asset-version/:versionId/stale-reasons", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      if (!versionId) return void res.status(400).json({ error: "versionId required" });
      const result = await previewReindexAssetVersion(versionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/embeddings/stale
  // Returns list of asset versions with stale or failed index lifecycle state
  app.get("/api/admin/embeddings/stale", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? "50")), 200);
      const result = await listStaleAssetVersions(limit);
      res.json({ count: result.length, limit, items: result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/embeddings/asset-version/:versionId/rebuild-impact
  // INV-EMB12: no writes — shows what a rebuild would do
  app.get("/api/admin/embeddings/asset-version/:versionId/rebuild-impact", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      if (!versionId) return void res.status(400).json({ error: "versionId required" });
      const result = await previewEmbeddingRebuildImpact(versionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/admin/embeddings/asset-version/:versionId/retrieval-readiness
  // INV-EMB4,9,12: canonical retrieval readiness explainability — no writes
  app.get("/api/admin/embeddings/asset-version/:versionId/retrieval-readiness", async (req: Request, res: Response) => {
    try {
      const versionId = String(req.params.versionId);
      if (!versionId) return void res.status(400).json({ error: "versionId required" });
      const result = await explainWhyAssetVersionIsOrIsNotRetrievalReady(versionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Phase 5M: Retrieval Explainability & Source Provenance ──────────────────

  // Route 1: GET /api/admin/retrieval/runs/:runId/provenance
  // INV-PROV1,2,6: per-run provenance — no writes
  app.get("/api/admin/retrieval/runs/:runId/provenance", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await buildRetrievalProvenanceForRun(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 2: GET /api/admin/retrieval/runs/:runId/explain
  // INV-PROV5,6: full explainability summary — no writes
  app.get("/api/admin/retrieval/runs/:runId/explain", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await summarizeRetrievalRunExplainability(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 3: GET /api/admin/retrieval/runs/:runId/context-provenance
  // INV-PROV12,6: context window provenance — no writes
  app.get("/api/admin/retrieval/runs/:runId/context-provenance", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await buildContextWindowProvenance(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 4: GET /api/admin/retrieval/runs/:runId/sources
  // INV-PROV2,6: list context sources for a run — no writes
  app.get("/api/admin/retrieval/runs/:runId/sources", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await listContextSourcesForRun(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5: GET /api/admin/retrieval/chunks/:chunkId/provenance
  // INV-PROV2,6: chunk provenance — no writes
  app.get("/api/admin/retrieval/chunks/:chunkId/provenance", async (req: Request, res: Response) => {
    try {
      const chunkId = String(req.params.chunkId);
      if (!chunkId) return void res.status(400).json({ error: "chunkId required" });
      const result = await buildChunkProvenance(chunkId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6: GET /api/admin/retrieval/chunks/:chunkId/explain?runId=&action=included|excluded
  // INV-PROV3,4,6: explain chunk inclusion or exclusion — no writes
  app.get("/api/admin/retrieval/chunks/:chunkId/explain", async (req: Request, res: Response) => {
    try {
      const chunkId = String(req.params.chunkId);
      const runId = String(req.query.runId ?? "");
      const action = String(req.query.action ?? "included");
      if (!chunkId) return void res.status(400).json({ error: "chunkId required" });
      if (!runId) return void res.status(400).json({ error: "runId query param required" });
      if (action !== "included" && action !== "excluded") {
        return void res.status(400).json({ error: "action must be 'included' or 'excluded'" });
      }
      const result =
        action === "included"
          ? await explainChunkInclusionInRun(runId, chunkId)
          : await explainChunkExclusionFromRun(runId, chunkId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7: GET /api/admin/retrieval/asset-versions/:assetVersionId/lineage
  // INV-PROV2,6: asset version lineage — no writes
  app.get("/api/admin/retrieval/asset-versions/:assetVersionId/lineage", async (req: Request, res: Response) => {
    try {
      const assetVersionId = String(req.params.assetVersionId);
      if (!assetVersionId) return void res.status(400).json({ error: "assetVersionId required" });
      const result = await buildAssetVersionLineage(assetVersionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8: GET /api/admin/retrieval/runs/:runId/summary
  // INV-PROV5,6: retrieval provenance summary — no writes
  app.get("/api/admin/retrieval/runs/:runId/summary", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await summarizeRetrievalProvenance(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9: GET /api/admin/retrieval/runs/:runId/context-sources-summary
  // INV-PROV7,6: context window source type summary — no writes
  app.get("/api/admin/retrieval/runs/:runId/context-sources-summary", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await summarizeContextWindowSources(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 5N: Hybrid Search & Reranking Admin Routes ─────────────────────────

  // Route 5N-1: GET /api/admin/retrieval/run/:runId/hybrid-summary
  // INV-HYB7,8: hybrid retrieval summary — no writes
  app.get("/api/admin/retrieval/run/:runId/hybrid-summary", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await summarizeHybridRetrieval(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5N-2: GET /api/admin/retrieval/run/:runId/hybrid-candidates
  // INV-HYB5,7: full hybrid candidate list with channel origins — no writes
  app.get("/api/admin/retrieval/run/:runId/hybrid-candidates", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await listHybridCandidateSources(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5N-3: GET /api/admin/retrieval/run/:runId/vector-candidates
  // INV-HYB5,7: vector-only channel candidates — no writes
  app.get("/api/admin/retrieval/run/:runId/vector-candidates", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const allSources = await listHybridCandidateSources(runId);
      const vectorOnly = {
        ...allSources,
        sources: allSources.sources.filter(
          (s) => s.channelOrigin === "vector_only" || s.channelOrigin === "vector_and_lexical",
        ),
        count: allSources.sources.filter(
          (s) => s.channelOrigin === "vector_only" || s.channelOrigin === "vector_and_lexical",
        ).length,
        filter: "vector_channel",
      };
      res.json(vectorOnly);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5N-4: GET /api/admin/retrieval/run/:runId/lexical-candidates
  // INV-HYB5,7: lexical-only channel candidates — no writes
  app.get("/api/admin/retrieval/run/:runId/lexical-candidates", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const allSources = await listHybridCandidateSources(runId);
      const lexicalOnly = {
        ...allSources,
        sources: allSources.sources.filter(
          (s) => s.channelOrigin === "lexical_only" || s.channelOrigin === "vector_and_lexical",
        ),
        count: allSources.sources.filter(
          (s) => s.channelOrigin === "lexical_only" || s.channelOrigin === "vector_and_lexical",
        ).length,
        filter: "lexical_channel",
      };
      res.json(lexicalOnly);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5N-5: GET /api/admin/retrieval/run/:runId/fusion-explain
  // INV-HYB5,7: full RRF fusion explainability — no writes
  app.get("/api/admin/retrieval/run/:runId/fusion-explain", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const [fusionDetail, strategyExplain] = await Promise.all([
        explainHybridFusion(runId),
        Promise.resolve(explainFusionStrategy()),
      ]);
      res.json({ ...fusionDetail, strategy: strategyExplain });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5N-6: GET /api/admin/retrieval/run/:runId/rerank-explain
  // INV-HYB6,7: reranking explainability — no writes
  app.get("/api/admin/retrieval/run/:runId/rerank-explain", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const [explain, impact] = await Promise.all([
        explainReranking(runId),
        summarizeRerankingImpact(runId),
      ]);
      res.json({ ...explain, impact });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5N-7: GET /api/admin/retrieval/run/:runId/channel-breakdown
  // INV-HYB4,7,8: channel breakdown by origin — no writes
  app.get("/api/admin/retrieval/run/:runId/channel-breakdown", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const fusion = await explainHybridFusion(runId);
      res.json({
        runId,
        channelBreakdown: fusion.channelBreakdown,
        totalCandidates: fusion.candidates.length,
        fusionStrategy: fusion.fusionStrategy,
        note: fusion.note,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5N-8: GET /api/admin/retrieval/run/:runId/final-context-scores
  // INV-HYB5,7: all score columns for selected candidates — no writes
  app.get("/api/admin/retrieval/run/:runId/final-context-scores", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const allCands = await listHybridCandidateSources(runId);
      const selected = {
        runId,
        filter: "selected_only",
        candidates: allCands.sources.filter((s) => s.filterStatus === "selected").map((s) => ({
          chunkId: s.chunkId,
          channelOrigin: s.channelOrigin,
          vectorScore: s.vectorScore,
          lexicalScore: s.lexicalScore,
          fusedScore: s.fusedScore,
          finalRank: s.finalRank,
        })),
        count: allCands.sources.filter((s) => s.filterStatus === "selected").length,
      };
      res.json(selected);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5N-9: POST /api/admin/retrieval/hybrid/preview
  // INV-HYB7: preview hybrid fusion without persisting — no writes to DB
  app.post("/api/admin/retrieval/hybrid/preview", async (req: Request, res: Response) => {
    try {
      const { vectorCandidates = [], lexicalCandidates = [], rrfOptions = {} } = req.body ?? {};
      if (!Array.isArray(vectorCandidates))
        return void res.status(400).json({ error: "vectorCandidates must be an array" });
      if (!Array.isArray(lexicalCandidates))
        return void res.status(400).json({ error: "lexicalCandidates must be an array" });

      const fused = fuseVectorAndLexicalCandidates(vectorCandidates, lexicalCandidates, rrfOptions);
      const strategyExplain = explainFusionStrategy(rrfOptions);
      res.json({
        fusedCandidates: fused,
        totalFused: fused.length,
        totalVectorOnly: fused.filter((c) => c.channelOrigin === "vector_only").length,
        totalLexicalOnly: fused.filter((c) => c.channelOrigin === "lexical_only").length,
        totalBothChannels: fused.filter((c) => c.channelOrigin === "vector_and_lexical").length,
        strategy: strategyExplain,
        note: "Preview only — no persistence. Use runHybridRetrieval with persistRun=true to persist.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 5O: Advanced Reranking admin routes ─────────────────────────────
  // All routes: admin/internal only, read-only except preview, no hidden writes
  // INV-RER7: all explain/* endpoints perform ZERO writes

  // Route 5O-1: GET /api/admin/retrieval/run/:runId/rerank-summary
  // Full advanced reranking summary for a run
  app.get("/api/admin/retrieval/run/:runId/rerank-summary", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const [shortlist, impact, calibration, fallback] = await Promise.all([
        summarizeShortlistComposition(runId),
        summarizeAdvancedRerankingImpact(runId),
        summarizeCalibrationFactors(runId),
        summarizeFallbackUsage(runId),
      ]);
      res.json({
        runId,
        shortlist,
        impact,
        calibration,
        fallback,
        providerInfo: explainAdvancedRerankingProvider(),
        note: "Phase 5O advanced reranking summary. Read-only — no writes performed.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5O-2: GET /api/admin/retrieval/run/:runId/rerank-candidates
  // Full candidate list with advanced rerank fields
  app.get("/api/admin/retrieval/run/:runId/rerank-candidates", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await listAdvancedRerankCandidates(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5O-3: GET /api/admin/retrieval/run/:runId/rerank-shortlist
  // Shortlist composition and strategy explanation
  app.get("/api/admin/retrieval/run/:runId/rerank-shortlist", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const [explain, summary] = await Promise.all([
        explainRerankShortlist(runId),
        summarizeShortlistComposition(runId),
      ]);
      res.json({ runId, explain, summary });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5O-4: GET /api/admin/retrieval/run/:runId/advanced-rerank-explain
  // Per-candidate advanced reranking explainability (INV-RER4,7)
  app.get("/api/admin/retrieval/run/:runId/advanced-rerank-explain", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const [explain, impact] = await Promise.all([
        explainAdvancedReranking(runId),
        summarizeAdvancedRerankingImpact(runId),
      ]);
      res.json({
        runId,
        explain,
        impact,
        providerInfo: explainAdvancedRerankingProvider(),
        note: "Read-only explainability endpoint. INV-RER7: no writes performed.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5O-5: GET /api/admin/retrieval/run/:runId/rerank-metrics
  // Reranking metrics: shortlist size, latency, token usage, cost, rank deltas
  app.get("/api/admin/retrieval/run/:runId/rerank-metrics", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const metrics = await summarizeAdvancedRerankMetrics(runId);
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5O-6: GET /api/admin/retrieval/run/:runId/fallback-summary
  // Fallback behavior explanation (INV-RER5)
  app.get("/api/admin/retrieval/run/:runId/fallback-summary", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const [explain, summary] = await Promise.all([
        explainFallbackReranking(runId),
        summarizeFallbackUsage(runId),
      ]);
      res.json({ runId, explain, summary });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5O-7: GET /api/admin/retrieval/run/:runId/final-score-breakdown
  // Final score calibration breakdown per candidate (INV-RER4)
  app.get("/api/admin/retrieval/run/:runId/final-score-breakdown", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const calibration = await summarizeCalibrationFactors(runId);
      res.json({
        runId,
        calibration,
        calibrationWeights: {
          advancedWeight: 0.7,
          fusedWeight: 0.3,
          formula: "final_score = 0.7 * heavy_rerank_score + 0.3 * fused_score",
          fallbackFormula: "final_score = fused_score (when heavy reranking unavailable)",
        },
        note: "Read-only. INV-RER4: fused_score, heavy_rerank_score, final_score always separately explainable.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5O-8: GET /api/admin/retrieval/run/:runId/rank-delta
  // Rank change analysis: promotions, demotions, stable ranks
  app.get("/api/admin/retrieval/run/:runId/rank-delta", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const impact = await summarizeAdvancedRerankingImpact(runId);
      res.json({
        runId,
        rerankMode: impact.rerankMode,
        shortlistSize: impact.shortlistSize,
        promotionCount: impact.promotionCount,
        demotionCount: impact.demotionCount,
        stableRankCount: impact.stableRankCount,
        largestPromotion: impact.largestPromotion,
        largestDemotion: impact.largestDemotion,
        avgFinalScore: impact.avgFinalScore,
        avgHeavyRerankScore: impact.avgHeavyRerankScore,
        note: impact.note,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5O-9: POST /api/admin/retrieval/rerank/preview
  // Preview advanced reranking on provided candidates — no persistence (INV-RER7)
  app.post("/api/admin/retrieval/rerank/preview", async (req: Request, res: Response) => {
    try {
      const { candidates = [], queryText, options = {} } = req.body ?? {};
      if (!Array.isArray(candidates))
        return void res.status(400).json({ error: "candidates must be an array" });
      if (typeof queryText !== "string" || !queryText.trim())
        return void res.status(400).json({ error: "queryText (string) required" });

      const result = await previewAdvancedReranking(candidates, queryText, options);
      res.json({
        rerankMode: result.rerankMode,
        fallbackUsed: result.fallbackUsed,
        fallbackReason: result.fallbackReason,
        shortlistSize: result.shortlistSize,
        metrics: result.metrics,
        candidates: result.candidates.map((c) => ({
          chunkId: c.chunkId,
          finalRank: c.finalRank,
          shortlistRank: c.shortlistRank,
          advancedRerankRank: c.advancedRerankRank,
          fusedScore: c.fusedScore,
          heavyRerankScore: c.heavyRerankScore,
          finalScore: c.finalScore,
          rerankMode: c.rerankMode,
          channelOrigin: c.channelOrigin,
        })),
        note: "Preview only — no persistence. Pass persistRun=true to runAdvancedReranking to persist results.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Phase 5P: Answer Grounding admin routes ───────────────────────────────

  // Route 5P-1: GET /api/admin/retrieval/answer/config
  // Return centralised retrieval configuration snapshot (INV-ANS7: no writes)
  app.get("/api/admin/retrieval/answer/config", async (_req: Request, res: Response) => {
    try {
      const config = describeRetrievalConfig();
      res.json({
        config,
        note: "Read-only retrieval config snapshot. Modify retrieval-config.ts to change defaults.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5P-2: GET /api/admin/retrieval/answer/runs/:runId
  // Summarise a persisted answer run (INV-ANS7: no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const summary = await summarizeAnswerGrounding(runId);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5P-3: GET /api/admin/retrieval/answer/runs/:runId/citations
  // Return citations for a persisted answer run (INV-ANS7: no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/citations", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const citations = await getAnswerCitations(runId);
      res.json(citations);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5P-4: GET /api/admin/retrieval/answer/runs/:runId/trace
  // Explain the full answer generation trace for a run (INV-ANS5/7: deterministic, no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/trace", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const trace = await explainAnswerTrace(runId);
      res.json(trace);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5P-5: GET /api/admin/retrieval/answer/runs/:runId/context
  // Return context window summary for a persisted answer run (INV-ANS7: no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/context", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const context = await getAnswerContext(runId);
      res.json(context);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5P-6: GET /api/admin/retrieval/answer/metrics/:tenantId
  // Tenant-level retrieval runtime metrics summary (INV-ANS8: tenant-isolated)
  app.get("/api/admin/retrieval/answer/metrics/:tenantId", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      const metrics = await summarizeRetrievalRuntimeMetrics(tenantId);
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 5Q — Retrieval Quality, Query Rewriting & Safety Guards
  // Routes: 5Q-1 → 5Q-9
  // INV-QUAL1: originalQuery always preserved
  // INV-QUAL2: rewrite/expansion deterministic (algorithmic only)
  // INV-QUAL3: expansion bounded by MAX_QUERY_EXPANSION_TERMS
  // INV-QUAL4–5: quality signals computed from chunks; confidence band assigned
  // INV-QUAL6: no false positives on clean chunks
  // INV-QUAL7: safety filter applied before answer generation
  // INV-QUAL8: explain/preview routes perform no writes
  // INV-QUAL9: quality metrics tenant-isolated
  // INV-QUAL10: existing retrieval tables unmodified
  // ─────────────────────────────────────────────────────────────────────────────

  // Route 5Q-1: GET /api/admin/retrieval/query-rewrite/config
  // Returns Phase 5Q configuration block (INV-QUAL8: no writes)
  app.get("/api/admin/retrieval/query-rewrite/config", async (_req: Request, res: Response) => {
    try {
      const cfg = describeRetrievalConfig();
      res.json({ config: cfg });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5Q-2: POST /api/admin/retrieval/query-rewrite/preview
  // Preview query rewrite result for a given query (INV-QUAL8: no writes, INV-QUAL1: original preserved)
  app.post("/api/admin/retrieval/query-rewrite/preview", async (req: Request, res: Response) => {
    try {
      const { queryText, tenantId } = req.body as { queryText?: string; tenantId?: string };
      if (!queryText) return void res.status(400).json({ error: "queryText required" });
      const result = await rewriteRetrievalQuery({
        queryText,
        tenantId: tenantId ?? "preview",
        enableSemanticRewrite: false,
      });
      const summary = summarizeQueryRewrite(result);
      const explain = explainQueryRewrite(result);
      res.json({ result, summary, explain });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5Q-3: POST /api/admin/retrieval/query-expand/preview
  // Preview query expansion for a given query (INV-QUAL8: no writes, INV-QUAL3: bounded)
  app.post("/api/admin/retrieval/query-expand/preview", async (req: Request, res: Response) => {
    try {
      const { queryText } = req.body as { queryText?: string };
      if (!queryText) return void res.status(400).json({ error: "queryText required" });
      const preview = previewExpandedQuery(queryText);
      const explain = explainQueryExpansion(queryText);
      res.json({ preview, explain });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5Q-4: GET /api/admin/retrieval/runs/:runId/quality-signals
  // Return quality signals for a retrieval run (INV-QUAL8: no writes)
  app.get("/api/admin/retrieval/runs/:runId/quality-signals", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const summary = await summarizeRetrievalQualitySignals(runId);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5Q-5: POST /api/admin/retrieval/safety/preview
  // Preview safety scan for a set of context chunks (INV-QUAL8: no writes, INV-QUAL6: no false positives)
  app.post("/api/admin/retrieval/safety/preview", async (req: Request, res: Response) => {
    try {
      const { chunks, safetyMode } = req.body as {
        chunks?: SafetyChunkInput[];
        safetyMode?: "monitor_only" | "downrank" | "exclude_high_risk";
      };
      if (!Array.isArray(chunks) || chunks.length === 0) {
        return void res.status(400).json({ error: "chunks array required" });
      }
      const mode = safetyMode ?? "monitor_only";
      const summary = buildRetrievalSafetySummary(chunks, mode);
      const explain = explainRetrievalSafety(summary);
      res.json({ summary, explain });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5Q-6: GET /api/admin/retrieval/runs/:runId/safety-summary
  // Return safety summary for a given retrieval run (read-only, INV-QUAL8)
  app.get("/api/admin/retrieval/runs/:runId/safety-summary", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const qualitySummary = await summarizeRetrievalQualitySignals(runId);
      res.json({
        runId,
        safetyStatus: qualitySummary.found ? qualitySummary.safetyStatus : null,
        flaggedChunkCount: qualitySummary.found ? qualitySummary.flaggedChunkCount : null,
        found: qualitySummary.found,
        note: "INV-QUAL8: no writes performed",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5Q-7: GET /api/admin/retrieval/runs/:runId/explain-quality
  // Explain quality signal computation for a given run (INV-QUAL8: no writes)
  app.get("/api/admin/retrieval/runs/:runId/explain-quality", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const signals = await summarizeRetrievalQualitySignals(runId);
      if (!signals.found) {
        return void res.status(404).json({ error: "No quality signals found for run", runId });
      }
      const explanation = await explainRetrievalQuality(runId);
      res.json(explanation);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5Q-8: GET /api/admin/retrieval/quality/metrics/:tenantId
  // Tenant-level quality metrics summary (INV-QUAL9: tenant-isolated)
  app.get("/api/admin/retrieval/quality/metrics/:tenantId", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      const metrics = await summarizeRetrievalQualityMetrics(tenantId);
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5Q-9: POST /api/admin/retrieval/quality/compute
  // Compute quality signals for a set of chunks (persist optional) — used by orchestrator
  app.post("/api/admin/retrieval/quality/compute", async (req: Request, res: Response) => {
    try {
      const { tenantId, retrievalRunId, chunks, persistSignals } = req.body as {
        tenantId?: string;
        retrievalRunId?: string;
        chunks?: QualityChunkInput[];
        persistSignals?: boolean;
      };
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      if (!retrievalRunId) return void res.status(400).json({ error: "retrievalRunId required" });
      if (!Array.isArray(chunks) || chunks.length === 0) {
        return void res.status(400).json({ error: "chunks array required" });
      }
      const signals = await computeRetrievalQualitySignals({
        tenantId,
        retrievalRunId,
        chunks,
        persistSignals: persistSignals ?? false,
      });
      res.json(signals);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 5R — Answer Safety, Hallucination Guard & Citation Coverage
  // Routes: 5R-1 → 5R-9
  // INV-ANSV1: Verification on real data only
  // INV-ANSV2: Claims never marked supported without evidence
  // INV-ANSV3: Coverage scoring deterministic
  // INV-ANSV4: Hallucination guard evidence-based
  // INV-ANSV5: Answer policy deterministic
  // INV-ANSV6: Answer text / citations not mutated
  // INV-ANSV7: Preview endpoints perform no writes
  // INV-ANSV8: Verification metrics tenant-isolated
  // INV-ANSV9: Existing retrieval/citation behavior intact
  // INV-ANSV10: Cross-tenant leakage impossible
  // ─────────────────────────────────────────────────────────────────────────────

  // Route 5R-1: GET /api/admin/retrieval/answer/runs/:runId/verification
  // Return answer verification metadata for a run (INV-ANSV7: no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/verification", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const metrics = await getAnswerVerificationMetrics(runId);
      if (!metrics) return void res.status(404).json({ error: "Answer run not found", runId });
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5R-2: GET /api/admin/retrieval/answer/runs/:runId/claims
  // Explain claims for a run — explain trace with claim extraction stages (INV-ANSV7: no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/claims", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const explanation = await explainAnswerVerification(runId);
      const stageDetail = await explainVerificationStage(runId);
      res.json({ explanation, stageDetail });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5R-3: GET /api/admin/retrieval/answer/runs/:runId/coverage
  // Return citation coverage summary for a run (INV-ANSV7: no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/coverage", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const coverage = await summarizeCitationCoverage(runId);
      res.json(coverage);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5R-4: GET /api/admin/retrieval/answer/runs/:runId/hallucination-summary
  // Return hallucination guard explanation for a run (INV-ANSV4/7: evidence-based, no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/hallucination-summary", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const explanation = await explainHallucinationGuard(runId);
      res.json(explanation);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5R-5: GET /api/admin/retrieval/answer/runs/:runId/policy
  // Return final answer policy explanation for a run (INV-ANSV5/7: deterministic, no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/policy", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const policyExpl = await explainAnswerPolicy(runId);
      res.json(policyExpl);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5R-6: GET /api/admin/retrieval/answer/runs/:runId/final-safe-answer
  // Return full pipeline trace including verification and policy (INV-ANSV7: no writes)
  app.get("/api/admin/retrieval/answer/runs/:runId/final-safe-answer", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const trace = await getAnswerVerificationTrace(runId);
      const policyExpl = await explainAnswerPolicy(runId);
      const coverage = await summarizeCitationCoverage(runId);
      res.json({
        runId,
        pipelineTrace: trace.traceStages,
        policyOutcome: policyExpl.policyOutcome,
        coverageRatio: coverage.citationCoverageRatio,
        groundingBand: coverage.groundingConfidenceBand,
        found: trace.found,
        note: "INV-ANSV7: no writes performed.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5R-7: GET /api/admin/retrieval/answer/metrics/:tenantId/verification
  // Tenant-level answer verification metrics (INV-ANSV8: tenant-isolated)
  app.get("/api/admin/retrieval/answer/metrics/:tenantId/verification", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      const metrics = await summarizeAnswerVerificationMetrics(tenantId);
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5R-8: POST /api/admin/retrieval/answer/verification/preview
  // Preview verification for a given answer + citations (INV-ANSV7: no writes)
  app.post("/api/admin/retrieval/answer/verification/preview", async (req: Request, res: Response) => {
    try {
      const { answerText, citations, retrievalSafetyStatus } = req.body as {
        answerText?: string;
        citations?: CitationInput[];
        retrievalSafetyStatus?: string;
      };
      if (!answerText) return void res.status(400).json({ error: "answerText required" });
      const result = await verifyGroundedAnswer({
        answerText,
        citations: citations ?? [],
        retrievalSafetyStatus: retrievalSafetyStatus ?? null,
        tenantId: "preview",
        persistVerification: false,
      });
      const claimPreview = previewExtractedClaims(answerText);
      res.json({ result, claimPreview });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5R-9: POST /api/admin/retrieval/answer/policy/preview
  // Preview final answer policy for given verification params (INV-ANSV5/7: deterministic, no writes)
  app.post("/api/admin/retrieval/answer/policy/preview", async (req: Request, res: Response) => {
    try {
      const {
        groundingConfidenceBand,
        groundingConfidenceScore,
        citationCoverageRatio,
        unsupportedClaimCount,
        totalClaimCount,
        hallucinationGuardStatus,
        retrievalSafetyStatus,
      } = req.body as {
        groundingConfidenceBand?: "high" | "medium" | "low" | "unsafe";
        groundingConfidenceScore?: number;
        citationCoverageRatio?: number;
        unsupportedClaimCount?: number;
        totalClaimCount?: number;
        hallucinationGuardStatus?: "no_issue" | "caution" | "high_risk";
        retrievalSafetyStatus?: string;
      };

      if (!groundingConfidenceBand) return void res.status(400).json({ error: "groundingConfidenceBand required" });
      if (groundingConfidenceScore === undefined) return void res.status(400).json({ error: "groundingConfidenceScore required" });
      if (citationCoverageRatio === undefined) return void res.status(400).json({ error: "citationCoverageRatio required" });

      const preview = previewAnswerPolicy({
        groundingConfidenceBand,
        groundingConfidenceScore,
        citationCoverageRatio,
        unsupportedClaimCount: unsupportedClaimCount ?? 0,
        totalClaimCount: totalClaimCount ?? 0,
        hallucinationGuardStatus: hallucinationGuardStatus ?? "no_issue",
        retrievalSafetyStatus: retrievalSafetyStatus ?? null,
      });
      res.json(preview);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Phase 5S — Retrieval Feedback Loop, Quality Evaluation & Auto-Tuning Signals
  // Routes: 5S-1 → 5S-10
  // INV-FB1: Feedback derived from real retrieval/answer run data only
  // INV-FB2: Quality bands deterministic
  // INV-FB3: Tuning signals evidence-based with rationale
  // INV-FB4: Rewrite effectiveness never overclaimed
  // INV-FB5: Rerank effectiveness never fabricated
  // INV-FB6: Citation quality based on real coverage data
  // INV-FB7: All feedback queries tenant-isolated
  // INV-FB8: Explain/preview routes perform no writes
  // INV-FB9: Existing retrieval/answer tables not modified
  // INV-FB10: Cross-tenant leakage impossible
  // ─────────────────────────────────────────────────────────────────────────────

  // Route 5S-1: GET /api/admin/retrieval/feedback/:runId/summary
  // Return summarized feedback for a retrieval run (INV-FB7: tenant-isolated, INV-FB8: no writes)
  app.get("/api/admin/retrieval/feedback/:runId/summary", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      const result = await summarizeRetrievalFeedback(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-2: GET /api/admin/retrieval/feedback/:runId/explain
  // Return staged explanation of persisted feedback for a run (INV-FB8: no writes)
  app.get("/api/admin/retrieval/feedback/:runId/explain", async (req: Request, res: Response) => {
    try {
      const { runId } = req.params;
      const result = await explainRetrievalFeedback(runId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-3: GET /api/admin/retrieval/feedback/tenant/:tenantId/weak-runs
  // List weak or failed retrieval runs for a tenant (INV-FB7, INV-FB10)
  app.get("/api/admin/retrieval/feedback/tenant/:tenantId/weak-runs", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const result = await listWeakRetrievalRuns({ tenantId, limit });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-4: GET /api/admin/retrieval/feedback/tenant/:tenantId/weak-patterns
  // Return aggregated failure pattern summary for a tenant (INV-FB7, INV-FB10)
  app.get("/api/admin/retrieval/feedback/tenant/:tenantId/weak-patterns", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const result = await listWeakPatterns({ tenantId, limit });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-5: GET /api/admin/retrieval/feedback/tenant/:tenantId/metrics
  // Return feedback quality metrics for a tenant (INV-FB7, INV-FB10)
  app.get("/api/admin/retrieval/feedback/tenant/:tenantId/metrics", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const result = await getFeedbackMetrics({ tenantId });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-6: GET /api/admin/retrieval/feedback/tenant/:tenantId/tuning-signals
  // Summarize auto-tuning signals emitted for a tenant (INV-FB3, INV-FB7)
  app.get("/api/admin/retrieval/feedback/tenant/:tenantId/tuning-signals", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const result = await summarizeTenantTuningSignals({ tenantId, limit });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-7: GET /api/admin/retrieval/feedback/tenant/:tenantId/feedback-summary
  // Return human-readable feedback summary for a tenant (INV-FB7, INV-FB8)
  app.get("/api/admin/retrieval/feedback/tenant/:tenantId/feedback-summary", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const result = await summarizeFeedbackMetrics({ tenantId });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-8: POST /api/admin/retrieval/feedback/record
  // Persist feedback notes for a retrieval run (write route — INV-FB7)
  app.post("/api/admin/retrieval/feedback/record", async (req: Request, res: Response) => {
    try {
      const { tenantId, runId, notes } = req.body as { tenantId?: string; runId?: string; notes?: string };
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      if (!runId) return void res.status(400).json({ error: "runId required" });
      const result = await recordFeedbackMetrics({ tenantId, runId, notes });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-9: POST /api/admin/retrieval/feedback/preview
  // Preview feedback evaluation for a hypothetical run without writing (INV-FB8: no writes)
  app.post("/api/admin/retrieval/feedback/preview", async (req: Request, res: Response) => {
    try {
      const { retrievalRun, qualitySignals, answerRun } = req.body as {
        retrievalRun?: unknown;
        qualitySignals?: unknown;
        answerRun?: unknown;
      };
      if (!retrievalRun) return void res.status(400).json({ error: "retrievalRun required" });
      if (!qualitySignals) return void res.status(400).json({ error: "qualitySignals required" });
      const result = await evaluateRetrievalRunFeedback({
        retrievalRun: retrievalRun as Parameters<typeof evaluateRetrievalRunFeedback>[0]["retrievalRun"],
        qualitySignals: qualitySignals as Parameters<typeof evaluateRetrievalRunFeedback>[0]["qualitySignals"],
        answerRun: answerRun as Parameters<typeof evaluateRetrievalRunFeedback>[0]["answerRun"],
        persistFeedback: false,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 5S-10: POST /api/admin/retrieval/feedback/preview/rerank
  // Explain rerank effectiveness for a hypothetical input (INV-FB5, INV-FB8: no writes)
  app.post("/api/admin/retrieval/feedback/preview/rerank", async (req: Request, res: Response) => {
    try {
      const {
        advancedRerankUsed,
        groundingConfidenceBand,
        citationCoverageRatio,
        shortlistSize,
        fallbackUsed,
      } = req.body as {
        advancedRerankUsed?: boolean;
        groundingConfidenceBand?: "high" | "medium" | "low" | "unsafe";
        citationCoverageRatio?: number;
        shortlistSize?: number;
        fallbackUsed?: boolean;
      };
      if (advancedRerankUsed === undefined) return void res.status(400).json({ error: "advancedRerankUsed required" });
      if (!groundingConfidenceBand) return void res.status(400).json({ error: "groundingConfidenceBand required" });
      if (citationCoverageRatio === undefined) return void res.status(400).json({ error: "citationCoverageRatio required" });
      const result = await explainRerankEffectiveness({
        advancedRerankUsed,
        groundingConfidenceBand,
        citationCoverageRatio,
        shortlistSize: shortlistSize ?? 0,
        fallbackUsed: fallbackUsed ?? false,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Phase 6 — Identity, RBAC & Actor Governance Foundation
  // Routes: 6-1 → 6-27
  // INV-ID1: Every resolved actor has explicit actor_type and tenant scope
  // INV-ID2: Permission checks are permission-code based, not role-name based
  // INV-ID3: Suspended/removed memberships must not grant permissions
  // INV-ID4: Disabled/archived roles or permissions must not grant access
  // INV-ID5: API keys and service-account keys never stored in plaintext
  // INV-ID6: Role bindings must be tenant-safe
  // INV-ID7: Revoked/expired keys must fail closed
  // INV-ID8: Preview/explain endpoints perform no unexpected writes
  // INV-ID9: Backward compatibility with current internal/admin flows
  // INV-ID10: Cross-tenant actor or permission leakage impossible
  // INV-ID11: System roles and bootstrap seeding must be idempotent
  // INV-ID12: Identity-provider foundation must remain explicit and non-fake
  // ─────────────────────────────────────────────────────────────────────────────

  // --- Memberships / Invites ---

  // Route 6-1: POST /api/admin/identity/tenants/:tenantId/memberships
  app.post("/api/admin/identity/tenants/:tenantId/memberships", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { userId, invitedBy, status } = req.body as { userId?: string; invitedBy?: string; status?: "active" | "invited" };
      if (!userId) return void res.status(400).json({ error: "userId required" });
      const { createTenantMembership } = await import("../lib/auth/memberships");
      const result = await createTenantMembership({ tenantId, userId, invitedBy, status });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-2: GET /api/admin/identity/tenants/:tenantId/memberships
  app.get("/api/admin/identity/tenants/:tenantId/memberships", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { listTenantMemberships } = await import("../lib/auth/memberships");
      const result = await listTenantMemberships(tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-3: POST /api/admin/identity/memberships/:membershipId/suspend
  app.post("/api/admin/identity/memberships/:membershipId/suspend", async (req: Request, res: Response) => {
    try {
      const { membershipId } = req.params;
      const { suspendTenantMembership } = await import("../lib/auth/memberships");
      const result = await suspendTenantMembership(membershipId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-4: POST /api/admin/identity/memberships/:membershipId/remove
  app.post("/api/admin/identity/memberships/:membershipId/remove", async (req: Request, res: Response) => {
    try {
      const { membershipId } = req.params;
      const { removeTenantMembership } = await import("../lib/auth/memberships");
      const result = await removeTenantMembership(membershipId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-5: POST /api/admin/identity/tenants/:tenantId/invitations
  app.post("/api/admin/identity/tenants/:tenantId/invitations", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { email, invitedBy, expiresInHours } = req.body as { email?: string; invitedBy?: string; expiresInHours?: number };
      if (!email) return void res.status(400).json({ error: "email required" });
      const { createTenantInvitation } = await import("../lib/auth/memberships");
      const result = await createTenantInvitation({ tenantId, email, invitedBy, expiresInHours });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-6: POST /api/admin/identity/invitations/:invitationId/revoke
  app.post("/api/admin/identity/invitations/:invitationId/revoke", async (req: Request, res: Response) => {
    try {
      const { invitationId } = req.params;
      const { revokeTenantInvitation } = await import("../lib/auth/memberships");
      const result = await revokeTenantInvitation(invitationId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-7: GET /api/admin/identity/tenants/:tenantId/invitations
  app.get("/api/admin/identity/tenants/:tenantId/invitations", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const pg = (await import("pg")).default;
      const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
      await client.connect();
      try {
        const row = await client.query(
          `SELECT id, email, invitation_status, expires_at, created_at FROM public.tenant_invitations WHERE tenant_id = $1 ORDER BY created_at DESC`,
          [tenantId],
        );
        res.json(row.rows);
      } finally { await client.end(); }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Roles / Permissions ---

  // Route 6-8: GET /api/admin/identity/permissions
  app.get("/api/admin/identity/permissions", async (_req: Request, res: Response) => {
    try {
      const pg = (await import("pg")).default;
      const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
      await client.connect();
      try {
        const row = await client.query(`SELECT id, permission_code, name, permission_domain, lifecycle_state FROM public.permissions ORDER BY permission_domain, permission_code`);
        res.json(row.rows);
      } finally { await client.end(); }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-9: GET /api/admin/identity/tenants/:tenantId/roles
  app.get("/api/admin/identity/tenants/:tenantId/roles", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const pg = (await import("pg")).default;
      const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
      await client.connect();
      try {
        const row = await client.query(
          `SELECT id, role_code, name, is_system_role, role_scope, lifecycle_state FROM public.roles WHERE (tenant_id = $1 OR role_scope = 'system') AND lifecycle_state = 'active' ORDER BY role_scope, role_code`,
          [tenantId],
        );
        res.json(row.rows);
      } finally { await client.end(); }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-10: POST /api/admin/identity/tenants/:tenantId/roles/bootstrap
  app.post("/api/admin/identity/tenants/:tenantId/roles/bootstrap", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { runIdentityBootstrap } = await import("../lib/auth/identity-bootstrap");
      const result = await runIdentityBootstrap(tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-11: POST /api/admin/identity/memberships/:membershipId/roles/:roleId
  app.post("/api/admin/identity/memberships/:membershipId/roles/:roleId", async (req: Request, res: Response) => {
    try {
      const { membershipId, roleId } = req.params;
      const { assignedBy } = req.body as { assignedBy?: string };
      const { assignRoleToMembership } = await import("../lib/auth/memberships");
      const result = await assignRoleToMembership({ membershipId, roleId, assignedBy });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-12: DELETE /api/admin/identity/memberships/:membershipId/roles/:roleId
  app.delete("/api/admin/identity/memberships/:membershipId/roles/:roleId", async (req: Request, res: Response) => {
    try {
      const { membershipId, roleId } = req.params;
      const { removeRoleFromMembership } = await import("../lib/auth/memberships");
      const result = await removeRoleFromMembership({ membershipId, roleId });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-13: GET /api/admin/identity/memberships/:membershipId/access-explainer
  app.get("/api/admin/identity/memberships/:membershipId/access-explainer", async (req: Request, res: Response) => {
    try {
      const { membershipId } = req.params;
      const { explainMembershipAccess } = await import("../lib/auth/memberships");
      const result = await explainMembershipAccess(membershipId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Service Accounts / Keys ---

  // Route 6-14: POST /api/admin/identity/tenants/:tenantId/service-accounts
  app.post("/api/admin/identity/tenants/:tenantId/service-accounts", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { name, description, createdBy } = req.body as { name?: string; description?: string; createdBy?: string };
      if (!name) return void res.status(400).json({ error: "name required" });
      const { createServiceAccount } = await import("../lib/auth/key-management");
      const result = await createServiceAccount({ tenantId, name, description, createdBy });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-15: GET /api/admin/identity/tenants/:tenantId/service-accounts
  app.get("/api/admin/identity/tenants/:tenantId/service-accounts", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { listTenantServiceAccounts } = await import("../lib/auth/key-management");
      const result = await listTenantServiceAccounts(tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-16: POST /api/admin/identity/service-accounts/:serviceAccountId/keys
  app.post("/api/admin/identity/service-accounts/:serviceAccountId/keys", async (req: Request, res: Response) => {
    try {
      const { serviceAccountId } = req.params;
      const { createdBy, expiresAt } = req.body as { createdBy?: string; expiresAt?: string };
      const { createServiceAccountKey } = await import("../lib/auth/key-management");
      const result = await createServiceAccountKey({ serviceAccountId, createdBy, expiresAt: expiresAt ? new Date(expiresAt) : undefined });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-17: POST /api/admin/identity/service-account-keys/:keyId/revoke
  app.post("/api/admin/identity/service-account-keys/:keyId/revoke", async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const { revokeServiceAccountKey } = await import("../lib/auth/key-management");
      const result = await revokeServiceAccountKey(keyId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- API Keys ---

  // Route 6-18: POST /api/admin/identity/tenants/:tenantId/api-keys
  app.post("/api/admin/identity/tenants/:tenantId/api-keys", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { name, createdBy, expiresAt, permissionIds } = req.body as {
        name?: string; createdBy?: string; expiresAt?: string; permissionIds?: string[];
      };
      if (!name) return void res.status(400).json({ error: "name required" });
      const { createApiKey } = await import("../lib/auth/key-management");
      const result = await createApiKey({ tenantId, name, createdBy, expiresAt: expiresAt ? new Date(expiresAt) : undefined, permissionIds });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-19: GET /api/admin/identity/tenants/:tenantId/api-keys
  app.get("/api/admin/identity/tenants/:tenantId/api-keys", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { listTenantApiKeys } = await import("../lib/auth/key-management");
      const result = await listTenantApiKeys(tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-20: POST /api/admin/identity/api-keys/:keyId/revoke
  app.post("/api/admin/identity/api-keys/:keyId/revoke", async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      const { revokeApiKey } = await import("../lib/auth/key-management");
      const result = await revokeApiKey(keyId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Identity Providers ---

  // Route 6-21: POST /api/admin/identity/tenants/:tenantId/providers
  app.post("/api/admin/identity/tenants/:tenantId/providers", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { providerType, displayName, issuer, audience, createdBy } = req.body as {
        providerType?: string; displayName?: string; issuer?: string; audience?: string; createdBy?: string;
      };
      if (!providerType) return void res.status(400).json({ error: "providerType required" });
      if (!displayName) return void res.status(400).json({ error: "displayName required" });
      const { createIdentityProvider } = await import("../lib/auth/identity-providers");
      const result = await createIdentityProvider({ tenantId, providerType: providerType as "oidc" | "saml" | "google_workspace" | "azure_ad", displayName, issuer, audience, createdBy });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-22: GET /api/admin/identity/tenants/:tenantId/providers
  app.get("/api/admin/identity/tenants/:tenantId/providers", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { listTenantIdentityProviders } = await import("../lib/auth/identity-providers");
      const result = await listTenantIdentityProviders(tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-23: POST /api/admin/identity/providers/:providerId/status
  app.post("/api/admin/identity/providers/:providerId/status", async (req: Request, res: Response) => {
    try {
      const { providerId } = req.params;
      const { newStatus } = req.body as { newStatus?: string };
      if (!newStatus) return void res.status(400).json({ error: "newStatus required" });
      const { updateIdentityProviderStatus } = await import("../lib/auth/identity-providers");
      const result = await updateIdentityProviderStatus({ providerId, newStatus: newStatus as "draft" | "active" | "disabled" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Explainers / Compatibility ---

  // Route 6-24: GET /api/admin/identity/actors/explain (INV-ID8: read-only)
  app.get("/api/admin/identity/actors/explain", (req: Request, res: Response) => {
    try {
      const { resolveRequestActor, explainResolvedActor } = require("../lib/auth/actor-resolution");
      const actorResult = resolveRequestActor(req);
      res.json(explainResolvedActor(actorResult));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-25: POST /api/admin/identity/preview/permission-check (INV-ID8: no writes)
  app.post("/api/admin/identity/preview/permission-check", (req: Request, res: Response) => {
    try {
      const { permissionCode, tenantId } = req.body as { permissionCode?: string; tenantId?: string };
      if (!permissionCode) return void res.status(400).json({ error: "permissionCode required" });
      const { resolveRequestActor } = require("../lib/auth/actor-resolution");
      const { explainPermissionDecision } = require("../lib/auth/permissions");
      const actorResult = resolveRequestActor(req);
      if (!actorResult.resolved) {
        return void res.json({ granted: false, reasonCode: actorResult.reasonCode, note: "INV-ID8: no writes" });
      }
      const decision = explainPermissionDecision(actorResult.actor, permissionCode, tenantId);
      res.json({ ...decision, note: "INV-ID8: Preview only. no writes performed." });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-26: GET /api/admin/identity/compatibility/state (INV-ID8: read-only)
  app.get("/api/admin/identity/compatibility/state", (_req: Request, res: Response) => {
    try {
      const { explainCurrentAuthCompatibilityState } = require("../lib/auth/identity-compat");
      res.json(explainCurrentAuthCompatibilityState());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-27: POST /api/admin/identity/compatibility/preview (INV-ID8: no writes)
  app.post("/api/admin/identity/compatibility/preview", (req: Request, res: Response) => {
    try {
      const { routePattern } = req.body as { routePattern?: string };
      if (!routePattern) return void res.status(400).json({ error: "routePattern required" });
      const { previewIdentityMigrationImpact } = require("../lib/auth/identity-compat");
      res.json(previewIdentityMigrationImpact(routePattern));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 7 — Platform Security & Session Management
  // Routes: 7-1 → 7-14
  // INV-SEC1: MFA secrets encrypted; INV-SEC2: Session tokens hashed
  // INV-SEC3: Revoked sessions never validate; INV-SEC4: IP allowlists enforced
  // INV-SEC5: Rate limits deterministic; INV-SEC6: Security headers on all responses
  // INV-SEC7: Upload validation rejects unsafe files; INV-SEC8: Security events tenant-isolated
  // ─────────────────────────────────────────────────────────────────────────────

  // Route 7-1: GET /api/admin/security/sessions — list sessions for a user
  app.get("/api/admin/security/sessions", async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as { userId?: string };
      if (!userId) return void res.status(400).json({ error: "userId required" });
      const { listUserSessions } = await import("../lib/auth/sessions");
      res.json(await listUserSessions(userId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-2: GET /api/admin/security/events — list security events (tenant-scoped or all)
  app.get("/api/admin/security/events", async (req: Request, res: Response) => {
    try {
      const { tenantId, userId, eventType, limit = "50" } = req.query as Record<string, string>;
      const pg = (await import("pg")).default;
      const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
      await client.connect();
      try {
        const conditions: string[] = [];
        const values: any[] = [];
        if (tenantId) { conditions.push(`tenant_id = $${values.length + 1}`); values.push(tenantId); }
        if (userId) { conditions.push(`user_id = $${values.length + 1}`); values.push(userId); }
        if (eventType) { conditions.push(`event_type = $${values.length + 1}`); values.push(eventType); }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const row = await client.query(
          `SELECT id, tenant_id, user_id, event_type, ip_address, metadata, created_at FROM public.security_events ${where} ORDER BY created_at DESC LIMIT $${values.length + 1}`,
          [...values, Math.min(parseInt(limit, 10), 500)],
        );
        res.json(row.rows);
      } finally { await client.end(); }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-3: POST /api/admin/security/revoke-session
  app.post("/api/admin/security/revoke-session", async (req: Request, res: Response) => {
    try {
      const { sessionId, revokedBy, reason } = req.body as { sessionId?: string; revokedBy?: string; reason?: string };
      if (!sessionId) return void res.status(400).json({ error: "sessionId required" });
      const { revokeSession } = await import("../lib/auth/sessions");
      res.json(await revokeSession({ sessionId, revokedBy, reason }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-4: POST /api/admin/security/revoke-all-sessions
  app.post("/api/admin/security/revoke-all-sessions", async (req: Request, res: Response) => {
    try {
      const { userId, reason } = req.body as { userId?: string; reason?: string };
      if (!userId) return void res.status(400).json({ error: "userId required" });
      const { revokeAllSessionsForUser } = await import("../lib/auth/sessions");
      res.json(await revokeAllSessionsForUser({ userId, reason }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-5: POST /api/admin/security/mfa/disable
  app.post("/api/admin/security/mfa/disable", async (req: Request, res: Response) => {
    try {
      const { userId, methodType } = req.body as { userId?: string; methodType?: "totp" };
      if (!userId) return void res.status(400).json({ error: "userId required" });
      const { disableMfa } = await import("../lib/auth/mfa");
      res.json(await disableMfa({ userId, methodType }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-6: POST /api/admin/security/mfa/enable
  app.post("/api/admin/security/mfa/enable", async (req: Request, res: Response) => {
    try {
      const { userId, methodType = "totp" } = req.body as { userId?: string; methodType?: "totp" };
      if (!userId) return void res.status(400).json({ error: "userId required" });
      const { enableMfaForUser } = await import("../lib/auth/mfa");
      res.json(await enableMfaForUser({ userId, methodType }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-7: POST /api/admin/security/mfa/verify
  app.post("/api/admin/security/mfa/verify", async (req: Request, res: Response) => {
    try {
      const { userId, code } = req.body as { userId?: string; code?: string };
      if (!userId || !code) return void res.status(400).json({ error: "userId and code required" });
      const { verifyMfaCode } = await import("../lib/auth/mfa");
      res.json(await verifyMfaCode({ userId, code }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-8: POST /api/admin/security/mfa/recovery-codes
  app.post("/api/admin/security/mfa/recovery-codes", async (req: Request, res: Response) => {
    try {
      const { userId, count } = req.body as { userId?: string; count?: number };
      if (!userId) return void res.status(400).json({ error: "userId required" });
      const { generateRecoveryCodes } = await import("../lib/auth/mfa");
      res.json(await generateRecoveryCodes({ userId, count }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-9: GET /api/admin/security/mfa/methods
  app.get("/api/admin/security/mfa/methods", async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as { userId?: string };
      if (!userId) return void res.status(400).json({ error: "userId required" });
      const { listUserMfaMethods } = await import("../lib/auth/mfa");
      res.json(await listUserMfaMethods(userId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-10: POST /api/admin/security/sessions/create (for testing)
  app.post("/api/admin/security/sessions/create", async (req: Request, res: Response) => {
    try {
      const { userId, deviceName, ipAddress, userAgent, tenantId } = req.body as Record<string, string>;
      if (!userId) return void res.status(400).json({ error: "userId required" });
      const { createSession } = await import("../lib/auth/sessions");
      res.json(await createSession({ userId, deviceName, ipAddress, userAgent, tenantId }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-11: GET /api/admin/security/ip-allowlist
  app.get("/api/admin/security/ip-allowlist", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.query as { tenantId?: string };
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      const { listTenantIpAllowlist } = await import("../middleware/ip-allowlist");
      res.json(await listTenantIpAllowlist(tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-12: POST /api/admin/security/ip-allowlist
  app.post("/api/admin/security/ip-allowlist", async (req: Request, res: Response) => {
    try {
      const { tenantId, ipRange, description } = req.body as { tenantId?: string; ipRange?: string; description?: string };
      if (!tenantId || !ipRange) return void res.status(400).json({ error: "tenantId and ipRange required" });
      const { addIpAllowlistEntry } = await import("../middleware/ip-allowlist");
      res.json(await addIpAllowlistEntry({ tenantId, ipRange, description }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-13: DELETE /api/admin/security/ip-allowlist
  app.delete("/api/admin/security/ip-allowlist", async (req: Request, res: Response) => {
    try {
      const { tenantId, ipRange } = req.body as { tenantId?: string; ipRange?: string };
      if (!tenantId || !ipRange) return void res.status(400).json({ error: "tenantId and ipRange required" });
      const { removeIpAllowlistEntry } = await import("../middleware/ip-allowlist");
      res.json(await removeIpAllowlistEntry({ tenantId, ipRange }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-14: GET /api/admin/security/headers/explain (INV-SEC6 read-only)
  app.get("/api/admin/security/headers/explain", async (_req: Request, res: Response) => {
    try {
      const { explainSecurityHeaders } = await import("../middleware/security-headers");
      res.json(explainSecurityHeaders());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-15: GET /api/admin/security/rate-limits/explain
  app.get("/api/admin/security/rate-limits/explain", async (_req: Request, res: Response) => {
    try {
      const { explainRateLimitState } = await import("../middleware/rate-limit");
      res.json(explainRateLimitState());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 7-16: POST /api/admin/security/upload/validate (INV-SEC7 read-only validation)
  app.post("/api/admin/security/upload/validate", async (req: Request, res: Response) => {
    try {
      const { claimedMimeType, base64Content, filename, maxSizeBytes } = req.body as {
        claimedMimeType?: string; base64Content?: string; filename?: string; maxSizeBytes?: number;
      };
      if (!claimedMimeType || !base64Content) return void res.status(400).json({ error: "claimedMimeType and base64Content required" });
      const { validateUpload } = await import("../lib/security/upload-validation");
      const buffer = Buffer.from(base64Content, "base64");
      res.json(validateUpload({ buffer, claimedMimeType, filename, maxSizeBytes }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 6-27 compat — also fix require() in identity-compat route
  // (already using require, but that route is Phase 6 — skip editing to avoid side effects)

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 8 — Global Audit Log Platform
  // Routes: 8-1 → 8-19
  // INV-AUD1–AUD12 enforced
  // ─────────────────────────────────────────────────────────────────────────────

  // Route 8-1: GET /api/admin/audit/events — global audit event list (admin only, up to 200 rows)
  app.get("/api/admin/audit/events", async (req: Request, res: Response) => {
    try {
      const { tenantId, action, actorType, resourceType, limit = "50", offset = "0" } = req.query as Record<string, string>;
      const { listAuditEventsByTenant } = await import("../lib/audit/audit-log");
      if (!tenantId) return void res.status(400).json({ error: "tenantId required (INV-AUD5: tenant-scoped query)" });
      res.json(await listAuditEventsByTenant({
        tenantId, action, actorType, resourceType,
        limit: Math.min(parseInt(limit, 10), 200),
        offset: parseInt(offset, 10),
      }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-2: GET /api/admin/audit/events/:auditEventId — single event
  app.get("/api/admin/audit/events/:auditEventId", async (req: Request, res: Response) => {
    try {
      const { auditEventId } = req.params;
      const { getAuditEventById } = await import("../lib/audit/audit-log");
      const result = await getAuditEventById(auditEventId);
      if (!result.event) return void res.status(404).json({ error: "Audit event not found" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-3: GET /api/admin/audit/tenant/:tenantId/events — tenant-scoped events
  app.get("/api/admin/audit/tenant/:tenantId/events", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { action, actorType, resourceType, limit = "50", offset = "0" } = req.query as Record<string, string>;
      const { listAuditEventsByTenant } = await import("../lib/audit/audit-log");
      res.json(await listAuditEventsByTenant({
        tenantId, action, actorType, resourceType,
        limit: Math.min(parseInt(limit, 10), 500),
        offset: parseInt(offset, 10),
      }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-4: GET /api/admin/audit/tenant/:tenantId/actors/:actorId/events — actor-scoped events
  app.get("/api/admin/audit/tenant/:tenantId/actors/:actorId/events", async (req: Request, res: Response) => {
    try {
      const { tenantId, actorId } = req.params;
      const { limit = "50" } = req.query as Record<string, string>;
      const { listAuditEventsByActor } = await import("../lib/audit/audit-log");
      res.json(await listAuditEventsByActor({ tenantId, actorId, limit: Math.min(parseInt(limit, 10), 200) }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-5: GET /api/admin/audit/tenant/:tenantId/resources/:resourceType/:resourceId/events — resource events
  app.get("/api/admin/audit/tenant/:tenantId/resources/:resourceType/:resourceId/events", async (req: Request, res: Response) => {
    try {
      const { tenantId, resourceType, resourceId } = req.params;
      const { limit = "50" } = req.query as Record<string, string>;
      const { listAuditEventsByResource } = await import("../lib/audit/audit-log");
      res.json(await listAuditEventsByResource({ tenantId, resourceType, resourceId, limit: Math.min(parseInt(limit, 10), 200) }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-6: GET /api/admin/audit/events/:auditEventId/explain — read-only explainer (INV-AUD7)
  app.get("/api/admin/audit/events/:auditEventId/explain", async (req: Request, res: Response) => {
    try {
      const { auditEventId } = req.params;
      const { explainAuditEvent } = await import("../lib/audit/audit-log");
      res.json(await explainAuditEvent(auditEventId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-7: POST /api/admin/audit/preview/context — audit context preview (INV-AUD7 read-only)
  app.post("/api/admin/audit/preview/context", async (req: Request, res: Response) => {
    try {
      const { explainAuditContext, buildAuditContextFromRequest } = await import("../lib/audit/audit-context");
      const ctx = buildAuditContextFromRequest(req, { auditSource: "admin_route" });
      res.json({
        ...explainAuditContext(ctx),
        note: "INV-AUD7: Preview is read-only — no audit event written.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-8: POST /api/admin/audit/preview/export — export preview (INV-AUD7 read-only)
  app.post("/api/admin/audit/preview/export", async (req: Request, res: Response) => {
    try {
      const { tenantId, filters } = req.body as { tenantId?: string; filters?: Record<string, unknown> };
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      const { explainAuditExport } = await import("../lib/audit/audit-export");
      res.json(explainAuditExport({ tenantId, filters: filters as any }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-9: GET /api/admin/audit/tenant/:tenantId/export/json — JSON export
  app.get("/api/admin/audit/tenant/:tenantId/export/json", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { action, actorType, resourceType, limit = "1000" } = req.query as Record<string, string>;
      const requestedBy = (req as any).user?.id ?? null;
      const { exportAuditEventsAsJson } = await import("../lib/audit/audit-export");
      const result = await exportAuditEventsAsJson({
        tenantId, requestedBy,
        filters: { action, actorType, resourceType, limit: parseInt(limit, 10) },
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-10: GET /api/admin/audit/tenant/:tenantId/export/csv — CSV export
  app.get("/api/admin/audit/tenant/:tenantId/export/csv", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { action, actorType, resourceType, limit = "1000" } = req.query as Record<string, string>;
      const requestedBy = (req as any).user?.id ?? null;
      const { exportAuditEventsAsCsv } = await import("../lib/audit/audit-export");
      const result = await exportAuditEventsAsCsv({
        tenantId, requestedBy,
        filters: { action, actorType, resourceType, limit: parseInt(limit, 10) },
      });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="audit-${tenantId}-${Date.now()}.csv"`);
      res.send(result.csv);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-11: GET /api/admin/audit/tenant/:tenantId/export-runs — list export runs
  app.get("/api/admin/audit/tenant/:tenantId/export-runs", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { limit = "20" } = req.query as Record<string, string>;
      const { listExportRunsForTenant } = await import("../lib/audit/audit-export");
      res.json(await listExportRunsForTenant({ tenantId, limit: parseInt(limit, 10) }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-12: GET /api/admin/audit/metrics/:tenantId — tenant audit metrics
  app.get("/api/admin/audit/metrics/:tenantId", async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const { getAuditMetricsByTenant } = await import("../lib/audit/audit-metrics");
      res.json(await getAuditMetricsByTenant(tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-13: GET /api/admin/audit/operational/state — operational health (INV-AUD12)
  app.get("/api/admin/audit/operational/state", async (_req: Request, res: Response) => {
    try {
      const { explainAuditOperationalState } = await import("../lib/audit/audit-metrics");
      res.json(await explainAuditOperationalState());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-14: GET /api/admin/audit/write-failures — write failure visibility (INV-AUD12)
  app.get("/api/admin/audit/write-failures", async (_req: Request, res: Response) => {
    try {
      const { listAuditWriteFailures } = await import("../lib/audit/audit-metrics");
      res.json({ failures: listAuditWriteFailures(), note: "INV-AUD12: Operational observability." });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-15: GET /api/admin/audit/compat/coverage — explain coverage (INV-AUD7)
  app.get("/api/admin/audit/compat/coverage", async (_req: Request, res: Response) => {
    try {
      const { explainCurrentAuditCoverage } = await import("../lib/audit/audit-compat");
      res.json(explainCurrentAuditCoverage());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-16: GET /api/admin/audit/compat/boundary — security vs audit boundary (INV-AUD9)
  app.get("/api/admin/audit/compat/boundary", async (_req: Request, res: Response) => {
    try {
      const { explainAuditVsSecurityEventBoundary } = await import("../lib/audit/audit-compat");
      res.json(explainAuditVsSecurityEventBoundary());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-17: POST /api/admin/audit/compat/preview-integration — preview integration impact (INV-AUD7)
  app.post("/api/admin/audit/compat/preview-integration", async (req: Request, res: Response) => {
    try {
      const { serviceArea } = req.body as { serviceArea?: string };
      if (!serviceArea) return void res.status(400).json({ error: "serviceArea required" });
      const { previewAuditIntegrationImpact } = await import("../lib/audit/audit-compat");
      res.json(previewAuditIntegrationImpact(serviceArea));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-18: GET /api/admin/audit/taxonomy — canonical action taxonomy
  app.get("/api/admin/audit/taxonomy", async (_req: Request, res: Response) => {
    try {
      const { explainAuditTaxonomy, ALL_AUDIT_ACTION_CODES, AUDIT_ACTION_DOMAINS } = await import("../lib/audit/audit-actions");
      res.json({ ...explainAuditTaxonomy(), allActionCodes: ALL_AUDIT_ACTION_CODES, domains: AUDIT_ACTION_DOMAINS });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 8-19: GET /api/admin/audit/metrics/summary — global summary (admin)
  app.get("/api/admin/audit/metrics/summary", async (_req: Request, res: Response) => {
    try {
      const { summarizeAuditMetrics } = await import("../lib/audit/audit-metrics");
      res.json(await summarizeAuditMetrics());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 9 — Tenant Lifecycle Management
  // Routes: 9-1 → 9-30
  // INV-TEN1–12 enforced
  // ─────────────────────────────────────────────────────────────────────────────

  // Route 9-1: POST /api/admin/tenants — create canonical tenant
  app.post("/api/admin/tenants", async (req: Request, res: Response) => {
    try {
      const { createTenant } = await import("../lib/tenant/tenant-lifecycle");
      const { name, tenantCode, lifecycleStatus, tenantType, billingEmail, defaultRegion, metadata, changedBy } = req.body;
      if (!name) return void res.status(400).json({ error: "name required" });
      res.status(201).json(await createTenant({ name, tenantCode, lifecycleStatus, tenantType, billingEmail, defaultRegion, metadata, changedBy: changedBy ?? (req as any).user?.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-2: GET /api/admin/tenants — list tenants
  app.get("/api/admin/tenants", async (req: Request, res: Response) => {
    try {
      const { listTenants } = await import("../lib/tenant/tenant-lifecycle");
      const { lifecycleStatus, tenantType, limit = "50", offset = "0" } = req.query as Record<string, string>;
      res.json(await listTenants({ lifecycleStatus: lifecycleStatus as any, tenantType: tenantType as any, limit: parseInt(limit, 10), offset: parseInt(offset, 10) }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-3: GET /api/admin/tenants/bootstrap/explain — read-only bootstrap state (INV-TEN9)
  app.get("/api/admin/tenants/bootstrap/explain", async (_req: Request, res: Response) => {
    try {
      const { explainTenantBootstrapState } = await import("../lib/tenant/tenant-bootstrap");
      res.json(await explainTenantBootstrapState());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-4: POST /api/admin/tenants/bootstrap — run bootstrap (idempotent, INV-TEN7)
  app.post("/api/admin/tenants/bootstrap", async (req: Request, res: Response) => {
    try {
      const { bootstrapCanonicalTenantsFromExistingData } = await import("../lib/tenant/tenant-bootstrap");
      const { dryRun, limit } = req.body as { dryRun?: boolean; limit?: number };
      res.json(await bootstrapCanonicalTenantsFromExistingData({ dryRun: dryRun ?? false, limit, changedBy: (req as any).user?.id ?? "admin_route" }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-5: POST /api/admin/tenants/preview/access-check — read-only access preview (INV-TEN9)
  app.post("/api/admin/tenants/preview/access-check", async (req: Request, res: Response) => {
    try {
      const { explainTenantAccessState } = await import("../lib/tenant/tenant-access");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      res.json(await explainTenantAccessState(tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-6: GET /api/admin/tenants/:tenantId — single tenant
  app.get("/api/admin/tenants/:tenantId", async (req: Request, res: Response) => {
    try {
      const { getTenantById } = await import("../lib/tenant/tenant-lifecycle");
      const t = await getTenantById(req.params.tenantId);
      if (!t) return void res.status(404).json({ error: "Tenant not found" });
      res.json(t);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-7: GET /api/admin/tenants/:tenantId/explain — lifecycle explain (INV-TEN9)
  app.get("/api/admin/tenants/:tenantId/explain", async (req: Request, res: Response) => {
    try {
      const { explainTenantLifecycle } = await import("../lib/tenant/tenant-lifecycle");
      res.json(await explainTenantLifecycle(req.params.tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-8: POST /api/admin/tenants/:tenantId/status — explicit status transition (INV-TEN2/3)
  app.post("/api/admin/tenants/:tenantId/status", async (req: Request, res: Response) => {
    try {
      const { updateTenantStatus } = await import("../lib/tenant/tenant-lifecycle");
      const { newStatus, reason } = req.body as { newStatus?: string; reason?: string };
      if (!newStatus) return void res.status(400).json({ error: "newStatus required" });
      res.json(await updateTenantStatus({ tenantId: req.params.tenantId, newStatus: newStatus as any, changedBy: (req as any).user?.id, reason }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-9: POST /api/admin/tenants/:tenantId/suspend
  app.post("/api/admin/tenants/:tenantId/suspend", async (req: Request, res: Response) => {
    try {
      const { suspendTenant } = await import("../lib/tenant/tenant-lifecycle");
      const { reason } = req.body as { reason?: string };
      res.json(await suspendTenant({ tenantId: req.params.tenantId, reason, changedBy: (req as any).user?.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-10: POST /api/admin/tenants/:tenantId/reactivate
  app.post("/api/admin/tenants/:tenantId/reactivate", async (req: Request, res: Response) => {
    try {
      const { reactivateTenant } = await import("../lib/tenant/tenant-lifecycle");
      const { reason } = req.body as { reason?: string };
      res.json(await reactivateTenant({ tenantId: req.params.tenantId, reason, changedBy: (req as any).user?.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-11: POST /api/admin/tenants/:tenantId/offboarding
  app.post("/api/admin/tenants/:tenantId/offboarding", async (req: Request, res: Response) => {
    try {
      const { startTenantOffboarding } = await import("../lib/tenant/tenant-lifecycle");
      const { reason } = req.body as { reason?: string };
      res.json(await startTenantOffboarding({ tenantId: req.params.tenantId, reason, changedBy: (req as any).user?.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-12: GET /api/admin/tenants/:tenantId/settings
  app.get("/api/admin/tenants/:tenantId/settings", async (req: Request, res: Response) => {
    try {
      const { getTenantSettings } = await import("../lib/tenant/tenant-settings");
      const settings = await getTenantSettings(req.params.tenantId);
      if (!settings) return void res.status(404).json({ error: "Settings not found" });
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-13: POST /api/admin/tenants/:tenantId/settings
  app.post("/api/admin/tenants/:tenantId/settings", async (req: Request, res: Response) => {
    try {
      const { createOrGetTenantSettings, updateTenantSettings, getTenantSettings } = await import("../lib/tenant/tenant-settings");
      const existing = await getTenantSettings(req.params.tenantId);
      if (existing) {
        res.json(await updateTenantSettings({ tenantId: req.params.tenantId, ...req.body, changedBy: (req as any).user?.id }));
      } else {
        const { createTenantSettings } = await import("../lib/tenant/tenant-settings");
        res.status(201).json(await createTenantSettings({ tenantId: req.params.tenantId, ...req.body, changedBy: (req as any).user?.id }));
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-14: POST /api/admin/tenants/:tenantId/domains
  app.post("/api/admin/tenants/:tenantId/domains", async (req: Request, res: Response) => {
    try {
      const { addTenantDomain } = await import("../lib/tenant/tenant-governance");
      const { domain } = req.body as { domain?: string };
      if (!domain) return void res.status(400).json({ error: "domain required" });
      res.status(201).json(await addTenantDomain({ tenantId: req.params.tenantId, domain, addedBy: (req as any).user?.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-15: GET /api/admin/tenants/:tenantId/domains
  app.get("/api/admin/tenants/:tenantId/domains", async (req: Request, res: Response) => {
    try {
      const { listTenantDomains } = await import("../lib/tenant/tenant-governance");
      res.json(await listTenantDomains(req.params.tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-16: POST /api/admin/tenants/:tenantId/export-requests
  app.post("/api/admin/tenants/:tenantId/export-requests", async (req: Request, res: Response) => {
    try {
      const { requestTenantExport } = await import("../lib/tenant/tenant-governance");
      const { exportScope, filterSummary } = req.body as { exportScope?: "full" | "metadata_only" | "audit_only"; filterSummary?: Record<string, unknown> };
      res.status(201).json(await requestTenantExport({ tenantId: req.params.tenantId, requestedBy: (req as any).user?.id ?? null, exportScope, filterSummary }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-17: GET /api/admin/tenants/:tenantId/export-requests
  app.get("/api/admin/tenants/:tenantId/export-requests", async (req: Request, res: Response) => {
    try {
      const { listTenantExportRequests } = await import("../lib/tenant/tenant-governance");
      res.json(await listTenantExportRequests(req.params.tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-18: POST /api/admin/tenant-export-requests/:requestId/start
  app.post("/api/admin/tenant-export-requests/:requestId/start", async (req: Request, res: Response) => {
    try {
      const { startTenantExport } = await import("../lib/tenant/tenant-governance");
      res.json(await startTenantExport(req.params.requestId, (req as any).user?.id));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-19: POST /api/admin/tenant-export-requests/:requestId/complete
  app.post("/api/admin/tenant-export-requests/:requestId/complete", async (req: Request, res: Response) => {
    try {
      const { completeTenantExport } = await import("../lib/tenant/tenant-governance");
      res.json(await completeTenantExport(req.params.requestId, req.body.resultSummary));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-20: POST /api/admin/tenant-export-requests/:requestId/fail
  app.post("/api/admin/tenant-export-requests/:requestId/fail", async (req: Request, res: Response) => {
    try {
      const { failTenantExport } = await import("../lib/tenant/tenant-governance");
      const { errorMessage } = req.body as { errorMessage?: string };
      if (!errorMessage) return void res.status(400).json({ error: "errorMessage required" });
      res.json(await failTenantExport(req.params.requestId, errorMessage));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-21: POST /api/admin/tenants/:tenantId/deletion-requests
  app.post("/api/admin/tenants/:tenantId/deletion-requests", async (req: Request, res: Response) => {
    try {
      const { requestTenantDeletion } = await import("../lib/tenant/tenant-governance");
      const { retentionUntil } = req.body as { retentionUntil?: string };
      res.status(201).json(await requestTenantDeletion({ tenantId: req.params.tenantId, requestedBy: (req as any).user?.id ?? null, retentionUntil: retentionUntil ? new Date(retentionUntil) : undefined }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-22: GET /api/admin/tenants/:tenantId/deletion-requests
  app.get("/api/admin/tenants/:tenantId/deletion-requests", async (req: Request, res: Response) => {
    try {
      const { listTenantDeletionRequests } = await import("../lib/tenant/tenant-governance");
      res.json(await listTenantDeletionRequests(req.params.tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-23: POST /api/admin/tenant-deletion-requests/:requestId/approve
  app.post("/api/admin/tenant-deletion-requests/:requestId/approve", async (req: Request, res: Response) => {
    try {
      const { approveTenantDeletion } = await import("../lib/tenant/tenant-governance");
      res.json(await approveTenantDeletion(req.params.requestId, (req as any).user?.id ?? "admin"));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-24: POST /api/admin/tenant-deletion-requests/:requestId/block
  app.post("/api/admin/tenant-deletion-requests/:requestId/block", async (req: Request, res: Response) => {
    try {
      const { blockTenantDeletion } = await import("../lib/tenant/tenant-governance");
      const { blockReason } = req.body as { blockReason?: string };
      if (!blockReason) return void res.status(400).json({ error: "blockReason required" });
      res.json(await blockTenantDeletion(req.params.requestId, blockReason, (req as any).user?.id ?? "admin"));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-25: POST /api/admin/tenant-deletion-requests/:requestId/start
  app.post("/api/admin/tenant-deletion-requests/:requestId/start", async (req: Request, res: Response) => {
    try {
      const { startTenantDeletion } = await import("../lib/tenant/tenant-governance");
      res.json(await startTenantDeletion(req.params.requestId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-26: POST /api/admin/tenant-deletion-requests/:requestId/complete
  app.post("/api/admin/tenant-deletion-requests/:requestId/complete", async (req: Request, res: Response) => {
    try {
      const { completeTenantDeletion } = await import("../lib/tenant/tenant-governance");
      res.json(await completeTenantDeletion(req.params.requestId, req.body.resultSummary));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-27: POST /api/admin/tenant-deletion-requests/:requestId/fail
  app.post("/api/admin/tenant-deletion-requests/:requestId/fail", async (req: Request, res: Response) => {
    try {
      const { failTenantDeletion } = await import("../lib/tenant/tenant-governance");
      const { errorMessage } = req.body as { errorMessage?: string };
      if (!errorMessage) return void res.status(400).json({ error: "errorMessage required" });
      res.json(await failTenantDeletion(req.params.requestId, errorMessage));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-28: GET /api/admin/tenants/:tenantId/governance — governance explain (INV-TEN9)
  app.get("/api/admin/tenants/:tenantId/governance", async (req: Request, res: Response) => {
    try {
      const { explainTenantGovernanceState } = await import("../lib/tenant/tenant-governance");
      res.json(await explainTenantGovernanceState(req.params.tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-29: GET /api/admin/tenants/:tenantId/summary — summarize state (INV-TEN9)
  app.get("/api/admin/tenants/:tenantId/summary", async (req: Request, res: Response) => {
    try {
      const { summarizeTenantState } = await import("../lib/tenant/tenant-lifecycle");
      res.json(await summarizeTenantState(req.params.tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 9-30: GET /api/admin/tenants/:tenantId/status-history — append-only history
  app.get("/api/admin/tenants/:tenantId/status-history", async (req: Request, res: Response) => {
    try {
      const { getTenantStatusHistory } = await import("../lib/tenant/tenant-lifecycle");
      res.json(await getTenantStatusHistory(req.params.tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase 10 — Knowledge Ingestion Platform
  // Routes: 10-1 → 10-8
  // ─────────────────────────────────────────────────────────────────────────────

  // Route 10-1: POST /api/admin/knowledge/sources — create source
  app.post("/api/admin/knowledge/sources", async (req: Request, res: Response) => {
    try {
      const { createKnowledgeSource } = await import("../lib/knowledge/knowledge-sources");
      const { tenantId, sourceType, name, status, metadata } = req.body;
      if (!tenantId || !sourceType || !name) return void res.status(400).json({ error: "tenantId, sourceType, name required" });
      res.status(201).json(await createKnowledgeSource({ tenantId, sourceType, name, status, metadata, actorId: (req as any).user?.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 10-2: GET /api/admin/knowledge/sources — list sources
  app.get("/api/admin/knowledge/sources", async (req: Request, res: Response) => {
    try {
      const { listKnowledgeSources } = await import("../lib/knowledge/knowledge-sources");
      const { tenantId, status, sourceType, limit = "50", offset = "0" } = req.query as Record<string, string>;
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      res.json(await listKnowledgeSources({ tenantId, status: status as any, sourceType: sourceType as any, limit: parseInt(limit, 10), offset: parseInt(offset, 10) }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 10-3: POST /api/admin/knowledge/documents — ingest document
  app.post("/api/admin/knowledge/documents", async (req: Request, res: Response) => {
    try {
      const { ingestDocument } = await import("../lib/knowledge/knowledge-documents");
      const { tenantId, sourceId, title, checksum, contentType, metadata } = req.body;
      if (!tenantId || !sourceId || !title) return void res.status(400).json({ error: "tenantId, sourceId, title required" });
      res.status(201).json(await ingestDocument({ tenantId, sourceId, title, checksum, contentType, metadata, actorId: (req as any).user?.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 10-4: GET /api/admin/knowledge/documents — list documents
  app.get("/api/admin/knowledge/documents", async (req: Request, res: Response) => {
    try {
      const { listIngestionDocuments } = await import("../lib/knowledge/knowledge-documents");
      const { tenantId, sourceId, documentStatus, limit = "50", offset = "0" } = req.query as Record<string, string>;
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      res.json(await listIngestionDocuments({ tenantId, sourceId, documentStatus: documentStatus as any, limit: parseInt(limit, 10), offset: parseInt(offset, 10) }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 10-5: GET /api/admin/knowledge/documents/:id — get single document
  app.get("/api/admin/knowledge/documents/:id", async (req: Request, res: Response) => {
    try {
      const { getIngestionDocumentById } = await import("../lib/knowledge/knowledge-documents");
      const { tenantId } = req.query as { tenantId?: string };
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      const doc = await getIngestionDocumentById(req.params.id, tenantId);
      if (!doc) return void res.status(404).json({ error: "Document not found" });
      res.json(doc);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 10-6: POST /api/admin/knowledge/ingest — full pipeline
  app.post("/api/admin/knowledge/ingest", async (req: Request, res: Response) => {
    try {
      const { runIngestionPipeline } = await import("../lib/knowledge/knowledge-ingestion");
      const { tenantId, sourceType, sourceName, existingSourceId, documentTitle, content, contentType, checksum, embeddingModel, chunkSize, chunkOverlap, vectorIndexed, lexicalIndexed } = req.body;
      if (!tenantId || !documentTitle || !content) return void res.status(400).json({ error: "tenantId, documentTitle, content required" });
      res.json(await runIngestionPipeline({ tenantId, sourceType, sourceName, existingSourceId, documentTitle, content, contentType, checksum, embeddingModel, chunkSize, chunkOverlap, vectorIndexed, lexicalIndexed, actorId: (req as any).user?.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 10-7: GET /api/admin/knowledge/documents/:id/pipeline — pipeline state (read-only)
  app.get("/api/admin/knowledge/documents/:id/pipeline", async (req: Request, res: Response) => {
    try {
      const { explainPipelineState } = await import("../lib/knowledge/knowledge-ingestion");
      const { tenantId } = req.query as { tenantId?: string };
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      res.json(await explainPipelineState({ tenantId, documentId: req.params.id }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Route 10-8: GET /api/admin/knowledge/index/summary — index state summary
  app.get("/api/admin/knowledge/index/summary", async (req: Request, res: Response) => {
    try {
      const { summarizeIndexState } = await import("../lib/knowledge/knowledge-indexing");
      const { tenantId } = req.query as { tenantId?: string };
      if (!tenantId) return void res.status(400).json({ error: "tenantId required" });
      res.json(await summarizeIndexState(tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
