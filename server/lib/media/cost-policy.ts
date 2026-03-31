// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// cost-policy.ts — Cost estimation, guardrails, and actual capture
// ============================================================

import type { MediaType, PipelineType, StepType, CostEstimate, PipelineStepDef } from "./media-types.ts";

// ── Cost rates (USD per unit) ─────────────────────────────────────────────────
// Based on Gemini API pricing (approximate, update as pricing changes)

const COST_RATES: Record<string, { perPage?: number; perSecond?: number; perMB?: number; base: number }> = {
  "google/gemini-2.5-flash": { perPage: 0.000075, perSecond: 0.0000025, perMB: 0.00005, base: 0.0001 },
  "google/gemini-1.5-pro":   { perPage: 0.00035,  perSecond: 0.000012,  perMB: 0.00025, base: 0.0005 },
};

// ── Global guardrails (can be overridden per tenant in future) ────────────────

export const GLOBAL_GUARDRAILS = {
  maxFileSizeBytes:   25 * 1024 * 1024,  // 25 MB upload limit
  maxAiFileSizeBytes: 18 * 1024 * 1024,  // 18 MB AI analysis limit
  maxVideoDurationSec: 600,               // 10 minutes
  maxAudioDurationSec: 3600,              // 60 minutes
  maxPdfPages: 500,
  maxFallbackDepth: 2,
  maxCostPerJobUsd: 0.50,                 // $0.50 per job hard limit
};

// ── Validation against guardrails ─────────────────────────────────────────────

export interface GuardrailCheck {
  blocked: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export function checkGuardrails(params: {
  mediaType: MediaType;
  fileSizeBytes: number;
  durationSec?: number;
  pageCount?: number;
}): GuardrailCheck {
  const { mediaType, fileSizeBytes, durationSec, pageCount } = params;

  if (fileSizeBytes > GLOBAL_GUARDRAILS.maxFileSizeBytes) {
    return {
      blocked: true,
      errorCode: "MEDIA_TOO_LARGE",
      errorMessage: `File size ${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB exceeds maximum ${GLOBAL_GUARDRAILS.maxFileSizeBytes / 1024 / 1024}MB`,
    };
  }

  if (fileSizeBytes > GLOBAL_GUARDRAILS.maxAiFileSizeBytes && mediaType !== "text") {
    return {
      blocked: true,
      errorCode: "MEDIA_TOO_LARGE_FOR_AI",
      errorMessage: `File size ${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB exceeds AI analysis limit of ${GLOBAL_GUARDRAILS.maxAiFileSizeBytes / 1024 / 1024}MB`,
    };
  }

  if (mediaType === "video" && durationSec && durationSec > GLOBAL_GUARDRAILS.maxVideoDurationSec) {
    return {
      blocked: true,
      errorCode: "VIDEO_TOO_LONG",
      errorMessage: `Video duration ${Math.round(durationSec)}s exceeds maximum ${GLOBAL_GUARDRAILS.maxVideoDurationSec}s`,
    };
  }

  if (mediaType === "audio" && durationSec && durationSec > GLOBAL_GUARDRAILS.maxAudioDurationSec) {
    return {
      blocked: true,
      errorCode: "AUDIO_TOO_LONG",
      errorMessage: `Audio duration ${Math.round(durationSec)}s exceeds maximum ${GLOBAL_GUARDRAILS.maxAudioDurationSec}s`,
    };
  }

  if (mediaType === "pdf" && pageCount && pageCount > GLOBAL_GUARDRAILS.maxPdfPages) {
    return {
      blocked: true,
      errorCode: "TOO_MANY_PAGES",
      errorMessage: `PDF has ${pageCount} pages, maximum is ${GLOBAL_GUARDRAILS.maxPdfPages}`,
    };
  }

  return { blocked: false };
}

// ── Cost estimation ───────────────────────────────────────────────────────────

export function estimateStepCost(params: {
  provider: string;
  model: string;
  stepType: StepType;
  fileSizeBytes: number;
  durationSec?: number;
  pageCount?: number;
}): number {
  const { provider, model, fileSizeBytes, durationSec, pageCount } = params;
  const key = `${provider}/${model}`;
  const rates = COST_RATES[key] ?? { base: 0.0001 };

  let cost = rates.base;

  if (pageCount && rates.perPage) {
    cost += pageCount * rates.perPage;
  } else if (rates.perMB) {
    cost += (fileSizeBytes / 1024 / 1024) * rates.perMB;
  }

  if (durationSec && rates.perSecond) {
    cost += durationSec * rates.perSecond;
  }

  return Math.round(cost * 1_000_000) / 1_000_000; // Round to 6 decimal places
}

export function estimateJobCost(params: {
  steps: PipelineStepDef[];
  mediaType: MediaType;
  fileSizeBytes: number;
  durationSec?: number;
  pageCount?: number;
}): CostEstimate {
  const { steps, fileSizeBytes, durationSec, pageCount } = params;

  const breakdown = steps.map((step) => ({
    step: step.stepType,
    provider: step.provider,
    model: step.model,
    cost: estimateStepCost({
      provider: step.provider,
      model: step.model,
      stepType: step.stepType,
      fileSizeBytes,
      durationSec,
      pageCount,
    }),
  }));

  const totalCost = breakdown.reduce((sum, b) => sum + b.cost, 0);
  const blocked = totalCost > GLOBAL_GUARDRAILS.maxCostPerJobUsd;

  return {
    estimatedCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    currency: "USD",
    breakdown,
    blocked,
    blockReason: blocked
      ? `COST_LIMIT_EXCEEDED: Estimated cost $${totalCost.toFixed(4)} exceeds limit $${GLOBAL_GUARDRAILS.maxCostPerJobUsd}`
      : undefined,
  };
}
