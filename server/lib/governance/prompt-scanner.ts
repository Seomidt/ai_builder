/**
 * Phase 24 — Prompt Scanner
 * Scans prompts for safety issues before forwarding to AI models.
 */

import crypto from "crypto";

// ── Prompt hash ───────────────────────────────────────────────────────────────

/**
 * Hash a prompt for storage (SHA-256, first 16 chars for brevity).
 */
export function hashPrompt(prompt: string): string {
  return crypto.createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 32);
}

// ── Threat categories ─────────────────────────────────────────────────────────

export type ThreatCategory =
  | "prompt_injection"
  | "jailbreak"
  | "harmful_content"
  | "pii"
  | "hate_speech"
  | "malware_generation"
  | "data_exfiltration"
  | "role_override"
  | "none";

export interface ScanResult {
  safe: boolean;
  threats: Array<{ category: ThreatCategory; confidence: number; detail: string }>;
  piiTypes: string[];
  score: number;         // 0 = clean, 100 = extremely dangerous
  recommendation: "allow" | "flag" | "block";
}

// ── Threat detection rules ────────────────────────────────────────────────────

interface ThreatRule {
  category: ThreatCategory;
  patterns: RegExp[];
  confidence: number;
  autoBlock: boolean;
}

const THREAT_RULES: ThreatRule[] = [
  {
    category: "prompt_injection",
    patterns: [
      /ignore\s+(previous|all|above)\s+(instructions?|prompt|context)/i,
      /disregard\s+your\s+(training|instructions?|system|previous)/i,
      /forget\s+(everything|all)\s+(you\s+know|above|previous)/i,
      /new\s+system\s+prompt/i,
    ],
    confidence: 0.95,
    autoBlock: true,
  },
  {
    category: "jailbreak",
    patterns: [
      /\bDAN\b/,
      /developer\s+mode/i,
      /jailbreak/i,
      /act\s+as\s+if\s+(you|your)\s+(have\s+no|are\s+without)\s+(restriction|filter|limitation)/i,
      /pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?(AI\s+without|unrestricted)/i,
    ],
    confidence: 0.9,
    autoBlock: true,
  },
  {
    category: "harmful_content",
    patterns: [
      /how\s+to\s+(make|build|create|synthesize)\s+(bomb|explosive|weapon|poison|drug)/i,
      /step[s\-]+by[- ]step\s+(instructions?\s+)?to\s+(kill|harm|hurt|murder)/i,
      /ways\s+to\s+(commit\s+suicide|self[\s-]harm|overdose)/i,
    ],
    confidence: 0.98,
    autoBlock: true,
  },
  {
    category: "malware_generation",
    patterns: [
      /write\s+(me\s+)?(a\s+)?(ransomware|keylogger|trojan|rootkit|worm|virus|malware|exploit)/i,
      /create\s+(a\s+)?(script\s+to\s+)?(hack|exploit|bypass\s+security|steal\s+credentials)/i,
    ],
    confidence: 0.95,
    autoBlock: true,
  },
  {
    category: "data_exfiltration",
    patterns: [
      /send\s+(this|all|the)\s+(data|information|content)\s+to\s+(http|https|www)/i,
      /\bexfiltrate\b/i,
      /leak\s+(sensitive|private|confidential)\s+(data|information)/i,
    ],
    confidence: 0.85,
    autoBlock: true,
  },
  {
    category: "role_override",
    patterns: [
      /you\s+are\s+now\s+(a\s+)?(different|new|another)\s+(AI|assistant|model|system)/i,
      /from\s+now\s+on\s+you\s+(will|are|must)\s+(be|act|behave)/i,
      /your\s+(true|real|actual)\s+(purpose|goal|job|task)\s+is/i,
    ],
    confidence: 0.8,
    autoBlock: false,
  },
];

// ── PII detection ─────────────────────────────────────────────────────────────

const PII_PATTERNS: Record<string, RegExp> = {
  email: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
  phone: /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
  credit_card: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/,
  ssn: /\b\d{3}[\s\-]?\d{2}[\s\-]?\d{4}\b/,
  ip_address: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  passport: /\b[A-Z]{1,2}\d{6,9}\b/,
};

function detectPiiTypes(prompt: string): string[] {
  const found: string[] = [];
  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    if (pattern.test(prompt)) found.push(type);
  }
  return found;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function computeScore(threats: ScanResult["threats"], piiCount: number): number {
  let score = 0;
  for (const t of threats) {
    score += t.confidence * 60;
  }
  score += piiCount * 5;
  return Math.min(Math.round(score), 100);
}

function getRecommendation(score: number, hasAutoBlock: boolean): ScanResult["recommendation"] {
  if (hasAutoBlock || score >= 70) return "block";
  if (score >= 30) return "flag";
  return "allow";
}

// ── Main scanner ──────────────────────────────────────────────────────────────

/**
 * Scan a prompt for safety threats.
 */
export function scanPrompt(prompt: string, options?: { sensitivityLevel?: "low" | "medium" | "high" }): ScanResult {
  const sensitivity = options?.sensitivityLevel ?? "medium";
  const confidenceThreshold = sensitivity === "high" ? 0.7 : sensitivity === "low" ? 0.95 : 0.8;

  const threats: ScanResult["threats"] = [];
  let hasAutoBlock = false;

  for (const rule of THREAT_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(prompt)) {
        if (rule.confidence >= confidenceThreshold) {
          threats.push({
            category: rule.category,
            confidence: rule.confidence,
            detail: `Matched pattern: ${pattern.source.slice(0, 60)}`,
          });
          if (rule.autoBlock) hasAutoBlock = true;
        }
        break; // One threat per category is enough
      }
    }
  }

  const piiTypes = detectPiiTypes(prompt);
  const score = computeScore(threats, piiTypes.length);
  const recommendation = getRecommendation(score, hasAutoBlock);

  return {
    safe: threats.length === 0 && piiTypes.length === 0,
    threats,
    piiTypes,
    score,
    recommendation,
  };
}

/**
 * Quick safety check — returns true if prompt is safe.
 */
export function isPromptSafe(prompt: string, sensitivityLevel?: "low" | "medium" | "high"): boolean {
  const result = scanPrompt(prompt, { sensitivityLevel });
  return result.recommendation !== "block";
}

/**
 * Get the primary threat category for a scan result.
 */
export function getPrimaryThreat(result: ScanResult): ThreatCategory {
  if (result.threats.length === 0) return "none";
  return result.threats.sort((a, b) => b.confidence - a.confidence)[0].category;
}

/**
 * Get blocked prompt statistics from moderation events.
 * (Called by observability layer — uses raw SQL via caller's db instance)
 */
export function buildBlockedPromptSummary(events: Array<Record<string, unknown>>): {
  totalBlocked: number;
  byEventType: Record<string, number>;
} {
  const blocked = events.filter(e => e.result === "blocked");
  const byType: Record<string, number> = {};
  for (const e of blocked) {
    const t = (e.event_type as string) ?? "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
  }
  return { totalBlocked: blocked.length, byEventType: byType };
}
