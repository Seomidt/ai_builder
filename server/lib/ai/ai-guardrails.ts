/**
 * Phase 12 — AI Guardrails
 * Protection against: prompt injection, unsafe instructions, system prompt override.
 * Security: pattern-matching, structured rejection, audit trail.
 */

// ─── Injection / override patterns ───────────────────────────────────────────
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+(a\s+)?(?!an?\s+AI|a\s+language\s+model)[a-z\s]{1,40}/i,
  /act\s+as\s+(if\s+you\s+are\s+)?(?!an?\s+AI|a\s+language\s+model)[a-z\s]{1,40}/i,
  /pretend\s+you\s+are\s+(?!an?\s+AI|a\s+language\s+model)/i,
  /\[system\]/i,
  /<\s*system\s*>/i,
  /override\s+system\s+prompt/i,
  /new\s+system\s+prompt\s*:/i,
  /your\s+new\s+instructions?\s+(are|is)\s*:/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /developer\s+mode\s+enabled/i,
];

// ─── Unsafe instruction patterns ─────────────────────────────────────────────
const UNSAFE_PATTERNS: RegExp[] = [
  /\b(bomb|explosive|weapon)\s+(instructions?|making|build|create|how\s+to)/i,
  /synthesize\s+(illegal\s+)?(drug|methamphetamine|fentanyl|heroin)/i,
  /child\s+(sexual|abuse|exploit)/i,
  /how\s+to\s+(hack|exploit|crack|bypass)\s+(bank|password|account|system)/i,
];

export type GuardrailResult =
  | { passed: true }
  | { passed: false; reason: "PROMPT_INJECTION" | "UNSAFE_INSTRUCTION" | "SYSTEM_OVERRIDE"; detail: string };

// ─── checkGuardrails ─────────────────────────────────────────────────────────
export function checkGuardrails(queryText: string): GuardrailResult {
  if (!queryText || queryText.trim().length === 0) {
    return { passed: false, reason: "PROMPT_INJECTION", detail: "Empty query text" };
  }

  // Check injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(queryText)) {
      return {
        passed: false,
        reason: "PROMPT_INJECTION",
        detail: `Query matches injection pattern: ${pattern.source.slice(0, 60)}`,
      };
    }
  }

  // Check unsafe instructions
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(queryText)) {
      return {
        passed: false,
        reason: "UNSAFE_INSTRUCTION",
        detail: `Query matches unsafe instruction pattern: ${pattern.source.slice(0, 60)}`,
      };
    }
  }

  // Check system prompt override in system prompt itself
  if (queryText.includes("###SYSTEM###") || queryText.includes("{{SYSTEM}}") || queryText.includes("__SYSTEM__")) {
    return { passed: false, reason: "SYSTEM_OVERRIDE", detail: "System prompt override marker detected" };
  }

  return { passed: true };
}

// ─── assertSafeQuery ─────────────────────────────────────────────────────────
export function assertSafeQuery(queryText: string): void {
  const result = checkGuardrails(queryText);
  if (!result.passed) {
    throw new Error(`Guardrail violation [${result.reason}]: ${result.detail}`);
  }
}

// ─── explainGuardrails ───────────────────────────────────────────────────────
// Read-only — returns what guardrails are active.
export function explainGuardrails(): {
  injectionPatternCount: number;
  unsafePatternCount: number;
  protections: string[];
  note: string;
} {
  return {
    injectionPatternCount: INJECTION_PATTERNS.length,
    unsafePatternCount: UNSAFE_PATTERNS.length,
    protections: [
      "prompt_injection_block",
      "unsafe_instruction_block",
      "system_prompt_override_block",
      "empty_query_block",
    ],
    note: "INV-AI7: All queries validated before model execution. No writes performed here.",
  };
}

// ─── sanitizeQuery ───────────────────────────────────────────────────────────
// Light sanitization for safe queries (trim, length cap).
export function sanitizeQuery(raw: string, maxLen = 4096): string {
  return raw.trim().slice(0, maxLen);
}
