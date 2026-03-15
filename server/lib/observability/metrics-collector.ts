/**
 * Phase 15 — Metrics Collector
 * Central metric entry point. Provides fail-safe wrappers for all
 * observability signals. All methods are fire-and-forget.
 *
 * INV-OBS-1: Metrics collection must never break primary workflows.
 * INV-OBS-3: Low overhead — no synchronous DB writes on critical paths.
 * INV-OBS-4: Request correlation preserved via requestId.
 * INV-OBS-6: Metrics writes must not block AI execution.
 */

import { recordAiLatencyMetric, type AiLatencyRecord } from "./latency-tracker";
import { recordRetrievalMetric, type RetrievalRecord } from "./retrieval-tracker";
import { recordAgentRunMetric, type AgentRunRecord } from "./agent-tracker";
import { incrementTenantUsage, type TenantMetricType } from "./tenant-usage-tracker";
import { db } from "../../db";
import { obsSystemMetrics } from "@shared/schema";

// ── AI latency collection ─────────────────────────────────────────────────────

/**
 * Collect AI latency telemetry. Fire-and-forget: never throws.
 * INV-OBS-6: Must never be awaited on critical AI paths.
 */
export function collectAiLatency(record: AiLatencyRecord): void {
  void recordAiLatencyMetric(record).catch(() => {});
  if (record.tenantId) {
    void incrementTenantUsage({
      tenantId: record.tenantId,
      metricType: "ai_requests",
      value: 1,
    }).catch(() => {});
    if (record.tokensIn) {
      void incrementTenantUsage({
        tenantId: record.tenantId,
        metricType: "tokens_in",
        value: record.tokensIn,
      }).catch(() => {});
    }
    if (record.tokensOut) {
      void incrementTenantUsage({
        tenantId: record.tenantId,
        metricType: "tokens_out",
        value: record.tokensOut,
      }).catch(() => {});
    }
    if (record.costUsd && record.costUsd > 0) {
      void incrementTenantUsage({
        tenantId: record.tenantId,
        metricType: "cost_usd",
        value: record.costUsd,
      }).catch(() => {});
    }
  }
}

// ── Retrieval collection ──────────────────────────────────────────────────────

/**
 * Collect retrieval telemetry. Fire-and-forget: never throws.
 */
export function collectRetrievalMetric(record: RetrievalRecord): void {
  void recordRetrievalMetric(record).catch(() => {});
  if (record.tenantId) {
    void incrementTenantUsage({
      tenantId: record.tenantId,
      metricType: "retrieval_queries",
      value: 1,
    }).catch(() => {});
  }
}

// ── Agent run collection ──────────────────────────────────────────────────────

/**
 * Collect agent run telemetry. Fire-and-forget: never throws.
 */
export function collectAgentRunMetric(record: AgentRunRecord): void {
  void recordAgentRunMetric(record).catch(() => {});
  if (record.tenantId) {
    void incrementTenantUsage({
      tenantId: record.tenantId,
      metricType: "agents_executed",
      value: 1,
    }).catch(() => {});
  }
}

// ── System metric collection ──────────────────────────────────────────────────

/**
 * Record a system-level metric. Fire-and-forget: never throws.
 */
export function collectSystemMetric(metricType: string, value: number, metadata?: Record<string, unknown>): void {
  void (async () => {
    try {
      await db.insert(obsSystemMetrics).values({
        metricType,
        value: String(value),
        metadata: metadata ?? null,
      });
    } catch {
      // INV-OBS-1: Silently swallow
    }
  })();
}

// ── Config / introspection ────────────────────────────────────────────────────

export function getCollectorConfig(): {
  version: string;
  signals: string[];
  fireAndForget: boolean;
  inv: string[];
} {
  return {
    version: "15.0",
    signals: ["ai_latency", "retrieval", "agent_runtime", "tenant_usage", "system"],
    fireAndForget: true,
    inv: ["INV-OBS-1", "INV-OBS-2", "INV-OBS-3", "INV-OBS-4", "INV-OBS-5", "INV-OBS-6"],
  };
}
