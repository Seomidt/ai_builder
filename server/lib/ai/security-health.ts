/**
 * Phase 12.1 — Security Health
 * In-memory violation counters + parser/orchestrator limit config report.
 */

import { MAX_HTML_OUTPUT_CHARS, MAX_RAW_INPUT_BYTES } from "./document-parsers";
import {
  MAX_CONTEXT_CHUNKS,
  MAX_CONTEXT_CHARS,
  MAX_QUERY_LENGTH,
  MAX_PROMPT_TOKENS_ESTIMATE,
  MAX_PIPELINE_TIME_MS,
} from "./ai-orchestrator";

// ─── In-process violation counters ───────────────────────────────────────────
const violations: Record<string, number> = {};
export function recordSecurityViolation(limitType: string): void {
  violations[limitType] = (violations[limitType] ?? 0) + 1;
}
export function getViolationCounts(): Record<string, number> {
  return { ...violations };
}

// ─── securityHealth ────────────────────────────────────────────────────────────
export function securityHealth(): {
  parserStatus: string;
  orchestratorStatus: string;
  limits: Record<string, number | string>;
  violationCounts: Record<string, number>;
  codeqlRemediations: string[];
} {
  return {
    parserStatus: "hardened",
    orchestratorStatus: "guarded",
    limits: {
      MAX_HTML_OUTPUT_CHARS,
      MAX_RAW_INPUT_BYTES,
      MAX_CONTEXT_CHUNKS,
      MAX_CONTEXT_CHARS,
      MAX_QUERY_LENGTH,
      MAX_PROMPT_TOKENS_ESTIMATE,
      MAX_PIPELINE_TIME_MS,
    },
    violationCounts: getViolationCounts(),
    codeqlRemediations: [
      "HTML parsing replaced with sanitize-html (no regex sanitization)",
      "Script/style tags fully stripped; all attributes removed",
      "Documents > 1MB rejected at parse time",
      "HTML output clamped to 50k chars",
      "NFKC normalization applied to all parsed text",
      "Plain text stored once — no double-escaping",
      "MAX_QUERY_LENGTH guard before orchestration",
      "MAX_CONTEXT_CHUNKS guard after retrieval",
      "MAX_CONTEXT_CHARS guard after context build",
      "MAX_PROMPT_TOKENS_ESTIMATE guard before model execution",
      "MAX_PIPELINE_TIME_MS timeout enforced",
      "Structured violation logging (tenant_id, request_id, limit_type, input_size)",
    ],
  };
}
