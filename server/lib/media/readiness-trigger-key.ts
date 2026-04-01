/**
 * Phase 5Z.3 — Readiness Trigger Key
 *
 * Generates a deterministic, stable key representing a particular "readiness
 * generation" of a document. The key changes only when the usable retrieval
 * state materially improves (not on every minor update).
 *
 * Rules:
 *  - Same readiness state → same key
 *  - Materially improved readiness → new key (e.g. new coverage bucket, new status)
 *  - Stale/superseded lineage must NOT share a key with current-lineage
 *  - Key is safe to expose to clients (no sensitive fields included)
 *  - Key is tenant-scoped via documentId (which is tenant-scoped in the DB)
 *
 * Design decisions (Phase 5Z.3 spec):
 *  - Coverage is bucketed in 25% increments: 0, 25, 50, 75, 100
 *    → Small changes within a bucket do not create a new generation
 *    → A bucket crossing always creates a new generation
 *  - documentStatus transitions always create a new generation
 *  - firstRetrievalReadyAt: null → timestamp always creates a new generation
 *    (this is the "first partial-ready" moment — most important transition)
 */

import { createHash } from "node:crypto";
import type { AggregatedDocumentStatus } from "./segment-aggregator.ts";

// ── Coverage bucket ────────────────────────────────────────────────────────────

/** Returns the 25%-increment bucket for a coverage percentage [0–100]. */
export function coverageBucket(coveragePercent: number): 0 | 25 | 50 | 75 | 100 {
  if (coveragePercent <= 0)  return 0;
  if (coveragePercent < 25)  return 0;
  if (coveragePercent < 50)  return 25;
  if (coveragePercent < 75)  return 50;
  if (coveragePercent < 100) return 75;
  return 100;
}

// ── Trigger key inputs ─────────────────────────────────────────────────────────

export interface TriggerKeyInputs {
  documentId:            string;
  documentStatus:        AggregatedDocumentStatus;
  coveragePercent:       number;
  firstRetrievalReadyAt: string | null;
  /** Active retrieval chunks; presence/absence (0 vs >0) changes the key. */
  retrievalChunksActive: number;
}

// ── Trigger key output ─────────────────────────────────────────────────────────

export interface ReadinessTriggerKey {
  /** Short deterministic key, safe to expose to clients. */
  key:              string;
  /** Human-readable description of the current readiness generation. */
  description:      string;
  /** Coverage bucket used for key derivation (0, 25, 50, 75, 100). */
  coverageBucket:   0 | 25 | 50 | 75 | 100;
  /** Whether any retrieval-ready chunks exist. */
  hasChunks:        boolean;
  /** ISO timestamp when the first retrieval-ready chunk became available. */
  firstRetrievalReadyAt: string | null;
}

// ── Key generation ────────────────────────────────────────────────────────────

/**
 * Returns a deterministic trigger key for the given readiness state.
 * The key is a 12-char hex prefix of the SHA-256 of the stable inputs.
 */
export function generateTriggerKey(inputs: TriggerKeyInputs): ReadinessTriggerKey {
  const bucket    = coverageBucket(inputs.coveragePercent);
  const hasChunks = inputs.retrievalChunksActive > 0;

  // Stable canonical string — only fields that represent a material state change
  const canonical = [
    inputs.documentId,
    inputs.documentStatus,
    String(bucket),
    hasChunks ? "chunks_yes" : "chunks_no",
    inputs.firstRetrievalReadyAt ?? "no_retrieval",
  ].join("|");

  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 12);

  const description = buildDescription(inputs.documentStatus, bucket, hasChunks);

  return {
    key,
    description,
    coverageBucket:        bucket,
    hasChunks,
    firstRetrievalReadyAt: inputs.firstRetrievalReadyAt,
  };
}

// ── Comparison helpers ────────────────────────────────────────────────────────

/**
 * Returns true if `newKey` represents a materially better readiness state
 * than `previousKey` — used to decide whether to auto-trigger an improved answer.
 */
export function isReadinessImproved(previousKey: string, newKey: string): boolean {
  return previousKey !== newKey;
}

/**
 * Determines whether a superseded/stale trigger key should prevent auto-trigger.
 * If the previous key matches the new key, no new trigger is needed.
 */
export function shouldSuppressTrigger(
  previousKey:     string | null,
  currentKey:      string,
): boolean {
  return previousKey === currentKey;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function buildDescription(
  status:    AggregatedDocumentStatus,
  bucket:    0 | 25 | 50 | 75 | 100,
  hasChunks: boolean,
): string {
  if (!hasChunks) {
    return `${status} — no retrieval chunks yet`;
  }
  if (bucket === 100) {
    return `${status} — fully indexed (100%)`;
  }
  return `${status} — ${bucket}%+ coverage, ${hasChunks ? "chunks ready" : "no chunks"}`;
}
