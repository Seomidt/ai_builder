/**
 * document-trust.ts — Phase 5F
 *
 * Lightweight probabilistic document trust-signal foundation.
 *
 * Design:
 *   - Append-only signal logging (no update, no delete)
 *   - No definitive AI-generated content claims
 *   - Probabilistic / signal-based assessment only
 *   - Audit-safe: every signal has a source, type, and confidence
 *   - Future support for documents, images, videos (signal_type is open text)
 *
 * INV-TRUST1: confidence_score is always 0.0–1.0
 * INV-TRUST2: risk_level is always one of: low_risk, medium_risk, high_risk, unknown
 * INV-TRUST3: signals never claim definitive AI generation
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db";
import { documentTrustSignals, documentRiskScores } from "@shared/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

export const TRUST_SCORING_VERSION = "v1.0";
export const RISK_LEVELS = ["low_risk", "medium_risk", "high_risk", "unknown"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// Thresholds for risk level derivation from aggregated signal confidence
const RISK_HIGH_THRESHOLD = 0.7;
const RISK_MEDIUM_THRESHOLD = 0.4;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrustSignalInput {
  tenantId: string;
  documentId: string;
  documentVersionId?: string;
  signalType: string;
  signalSource: string;
  confidenceScore: number;
  rawEvidence?: Record<string, unknown>;
}

export interface RiskScoreInput {
  tenantId: string;
  documentId: string;
  documentVersionId?: string;
  signals: Array<{ signalType: string; confidenceScore: number }>;
  scoringVersion?: string;
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Record a probabilistic trust signal for a document.
 * Append-only — never updates existing signals.
 *
 * INV-TRUST1: confidence_score clamped to 0.0–1.0
 */
export async function recordDocumentTrustSignal(
  params: TrustSignalInput,
): Promise<{ signalId: string }> {
  const {
    tenantId,
    documentId,
    documentVersionId,
    signalType,
    signalSource,
    rawEvidence,
  } = params;

  const confidenceScore = Math.max(0, Math.min(1, params.confidenceScore));

  const [row] = await db
    .insert(documentTrustSignals)
    .values({
      tenantId,
      documentId,
      documentVersionId: documentVersionId ?? null,
      signalType,
      signalSource,
      confidenceScore: String(confidenceScore.toFixed(4)),
      rawEvidence: rawEvidence ?? null,
    })
    .returning({ id: documentTrustSignals.id });

  return { signalId: row.id };
}

/**
 * Derive and record a risk score from existing trust signals.
 *
 * Risk algorithm:
 *   - Average confidence across all provided signals
 *   - High:   avg >= 0.7
 *   - Medium: avg >= 0.4
 *   - Low:    avg < 0.4
 *   - Unknown: no signals
 */
export async function calculateDocumentRiskScore(
  params: RiskScoreInput,
): Promise<{ riskScoreId: string; riskLevel: RiskLevel; riskScore: number }> {
  const {
    tenantId,
    documentId,
    documentVersionId,
    signals,
    scoringVersion = TRUST_SCORING_VERSION,
  } = params;

  let riskLevel: RiskLevel = "unknown";
  let riskScore = 0;

  if (signals.length > 0) {
    riskScore =
      signals.reduce((sum, s) => sum + Math.max(0, Math.min(1, s.confidenceScore)), 0) /
      signals.length;

    if (riskScore >= RISK_HIGH_THRESHOLD) riskLevel = "high_risk";
    else if (riskScore >= RISK_MEDIUM_THRESHOLD) riskLevel = "medium_risk";
    else riskLevel = "low_risk";
  }

  const [row] = await db
    .insert(documentRiskScores)
    .values({
      tenantId,
      documentId,
      documentVersionId: documentVersionId ?? null,
      riskLevel,
      riskScore: String(riskScore.toFixed(4)),
      scoringVersion,
      contributingSignals: signals as unknown as Record<string, unknown>,
    })
    .returning({ id: documentRiskScores.id });

  return { riskScoreId: row.id, riskLevel, riskScore };
}

/**
 * Retrieve all trust signals for a document (most recent first).
 */
export async function getDocumentTrustSignals(
  documentId: string,
  tenantId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(documentTrustSignals)
    .where(
      and(
        eq(documentTrustSignals.documentId, documentId),
        eq(documentTrustSignals.tenantId, tenantId),
      ),
    )
    .orderBy(desc(documentTrustSignals.createdAt));

  return rows.map((row) => ({
    signalId: row.id,
    tenantId: row.tenantId,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    signalType: row.signalType,
    signalSource: row.signalSource,
    confidenceScore: row.confidenceScore,
    rawEvidence: row.rawEvidence,
    createdAt: row.createdAt,
  }));
}

/**
 * Get the most recent risk score for a document.
 */
export async function getDocumentRiskScore(
  documentId: string,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select()
    .from(documentRiskScores)
    .where(
      and(
        eq(documentRiskScores.documentId, documentId),
        eq(documentRiskScores.tenantId, tenantId),
      ),
    )
    .orderBy(desc(documentRiskScores.createdAt))
    .limit(1);

  if (!row) return null;

  return {
    riskScoreId: row.id,
    tenantId: row.tenantId,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    riskLevel: row.riskLevel,
    riskScore: row.riskScore,
    scoringVersion: row.scoringVersion,
    contributingSignals: row.contributingSignals,
    createdAt: row.createdAt,
  };
}

/**
 * Explain the trust state of a document for admin inspection.
 * Aggregates all signals + most recent risk score.
 */
export async function explainDocumentTrust(
  documentId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const signals = await getDocumentTrustSignals(documentId, tenantId);
  const latestRisk = await getDocumentRiskScore(documentId, tenantId);

  const signalTypes = Array.from(new Set(signals.map((s) => s.signalType as string)));
  const signalSources = Array.from(new Set(signals.map((s) => s.signalSource as string)));

  const avgConfidence =
    signals.length > 0
      ? signals.reduce((sum, s) => sum + parseFloat(String(s.confidenceScore)), 0) / signals.length
      : null;

  return {
    documentId,
    tenantId,
    totalSignals: signals.length,
    signalTypes,
    signalSources,
    avgConfidence: avgConfidence != null ? Number(avgConfidence.toFixed(4)) : null,
    latestRiskLevel: latestRisk?.riskLevel ?? "unknown",
    latestRiskScore: latestRisk?.riskScore ?? null,
    scoringVersion: latestRisk?.scoringVersion ?? null,
    signals,
    note: "Trust signals are probabilistic indicators only. No definitive claims about content origin are made.",
    disclaimer: "This system does not definitively detect AI-generated content. Signals are advisory only.",
  };
}
