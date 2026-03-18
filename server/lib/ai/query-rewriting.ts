/**
 * query-rewriting.ts — Phase 5Q
 *
 * Query normalization, rewriting, and deterministic expansion for retrieval.
 *
 * Design invariants:
 *   INV-QUAL1  Original query is always preserved
 *   INV-QUAL2  Rewrite is deterministic (temperature=0, bounded rules)
 *   INV-QUAL3  Expansion is bounded by MAX_QUERY_EXPANSION_TERMS
 *   INV-QUAL8  Preview functions perform no writes
 *
 * Strategy hierarchy:
 *   passthrough          — query is already clean, no expansion
 *   normalize_only       — whitespace/case cleanup only
 *   expand_and_rewrite   — normalized + synonym/acronym expansion
 *   semantic_rewrite     — LLM-assisted retrieval-optimized rewrite (with fallback)
 */

import OpenAI from "openai";
import {
  MAX_QUERY_EXPANSION_TERMS,
  QUERY_REWRITE_ENABLED,
  QUERY_EXPANSION_ENABLED,
  QUERY_REWRITE_TIMEOUT_MS,
  clampExpansionTerms,
} from "../config/retrieval-config";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RewriteStrategy =
  | "passthrough"
  | "normalize_only"
  | "expand_and_rewrite"
  | "semantic_rewrite";

export interface QueryRewriteResult {
  originalQuery: string;
  normalizedQuery: string;
  rewrittenQuery: string;
  expandedTerms: string[];
  rewriteStrategy: RewriteStrategy;
  latencyMs: number;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  expansionCount: number;
}

export interface QueryExpansionExplanation {
  originalQuery: string;
  expansionTerms: string[];
  expansionSources: Array<{ term: string; source: "acronym" | "synonym" | "plural" | "singular" }>;
  bounded: boolean;
  limit: number;
  count: number;
  note: string;
}

// ── Static expansion tables ───────────────────────────────────────────────────
// Bounded, explicit, deterministic. No fuzzy or generative expansion.

const ACRONYM_EXPANSIONS: Record<string, string> = {
  ai: "artificial intelligence",
  ml: "machine learning",
  nlp: "natural language processing",
  api: "application programming interface",
  db: "database",
  ui: "user interface",
  ux: "user experience",
  saas: "software as a service",
  paas: "platform as a service",
  iaas: "infrastructure as a service",
  sdk: "software development kit",
  ci: "continuous integration",
  cd: "continuous deployment",
  llm: "large language model",
  rag: "retrieval augmented generation",
  jwt: "json web token",
  rbac: "role based access control",
  sso: "single sign on",
  mfa: "multi factor authentication",
  etl: "extract transform load",
};

const SYNONYM_EXPANSIONS: Record<string, string[]> = {
  error: ["failure", "issue", "exception", "problem", "fault"],
  config: ["configuration", "settings", "setup"],
  auth: ["authentication", "authorization"],
  deploy: ["deployment", "release", "publish"],
  search: ["query", "find", "retrieve", "lookup"],
  document: ["file", "record", "page"],
  user: ["account", "profile", "member"],
  tenant: ["organization", "workspace", "account"],
  chunk: ["segment", "fragment", "passage"],
  embedding: ["vector", "representation"],
  retrieval: ["search", "lookup", "fetch"],
  answer: ["response", "reply", "result"],
};

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a retrieval query deterministically (INV-QUAL2).
 * Preserves semantic content; strips only redundant whitespace and punctuation artifacts.
 */
// Phase 42 fix: cap input length to prevent resource exhaustion on pathological inputs.
// The regex patterns in this function are linear (character classes, no nested groups),
// but unbounded input length still creates O(n) memory and CPU pressure.
const MAX_QUERY_INPUT_LENGTH = 2_000;

export function normalizeRetrievalQuery(query: string): string {
  if (!query || typeof query !== "string") return "";
  // Cap input length BEFORE any regex processing — prevents resource exhaustion
  const capped = query.length > MAX_QUERY_INPUT_LENGTH
    ? query.slice(0, MAX_QUERY_INPUT_LENGTH)
    : query;
  return capped
    .trim()
    .replace(/\s+/g, " ")              // condense multiple spaces (safe: char class, O(n))
    .replace(/^[^\w]+|[^\w?!]+$/g, "") // strip leading/trailing non-word except ? ! (safe: anchored char class)
    .normalize("NFKC");                // unicode normalize
}

// ── Expansion ─────────────────────────────────────────────────────────────────

/**
 * Build bounded, deterministic expansion terms for a query (INV-QUAL3).
 * Returns an array of at most MAX_QUERY_EXPANSION_TERMS unique terms.
 */
export function buildQueryExpansionTerms(query: string): string[] {
  if (!QUERY_EXPANSION_ENABLED) return [];

  const normalized = normalizeRetrievalQuery(query).toLowerCase();
  // Keep all tokens >= 2 chars for acronym lookup; >= 3 for synonym/plural
  const allTokens = normalized.split(/\s+/).filter((t) => t.length >= 2);
  const longTokens = allTokens.filter((t) => t.length > 2);
  const expansions = new Set<string>();

  for (const token of allTokens) {
    if (expansions.size >= MAX_QUERY_EXPANSION_TERMS) break;

    // Acronym expansion (works for 2-char tokens like "ai", "db", "ui")
    if (ACRONYM_EXPANSIONS[token]) {
      expansions.add(ACRONYM_EXPANSIONS[token]);
    }
  }

  for (const token of longTokens) {
    if (expansions.size >= MAX_QUERY_EXPANSION_TERMS) break;

    // Synonym expansion
    const synonyms = SYNONYM_EXPANSIONS[token];
    if (synonyms) {
      for (const syn of synonyms) {
        if (expansions.size >= MAX_QUERY_EXPANSION_TERMS) break;
        expansions.add(syn);
      }
    }

    // Plural/singular (simple English rules, deterministic)
    if (token.endsWith("s") && token.length > 4) {
      // try de-plural: "errors" → "error"
      const singular = token.slice(0, -1);
      if (!allTokens.includes(singular)) expansions.add(singular);
    } else if (!token.endsWith("s") && token.length > 3) {
      // try plural: "error" → "errors"
      const plural = token + "s";
      if (!allTokens.includes(plural)) expansions.add(plural);
    }
  }

  return [...expansions].slice(0, clampExpansionTerms(MAX_QUERY_EXPANSION_TERMS));
}

/**
 * Explain expansion for observability (INV-QUAL8: no writes).
 */
export function explainQueryExpansion(query: string): QueryExpansionExplanation {
  const normalized = normalizeRetrievalQuery(query).toLowerCase();
  const allTokens = normalized.split(/\s+/).filter((t) => t.length >= 2);
  const longTokens = allTokens.filter((t) => t.length > 2);
  const sources: QueryExpansionExplanation["expansionSources"] = [];
  const seen = new Set<string>();

  for (const token of allTokens) {
    if (seen.size >= MAX_QUERY_EXPANSION_TERMS) break;
    if (ACRONYM_EXPANSIONS[token]) {
      const t = ACRONYM_EXPANSIONS[token];
      if (!seen.has(t)) { sources.push({ term: t, source: "acronym" }); seen.add(t); }
    }
  }

  for (const token of longTokens) {
    if (seen.size >= MAX_QUERY_EXPANSION_TERMS) break;
    const synonyms = SYNONYM_EXPANSIONS[token];
    if (synonyms) {
      for (const s of synonyms) {
        if (seen.size >= MAX_QUERY_EXPANSION_TERMS) break;
        if (!seen.has(s)) { sources.push({ term: s, source: "synonym" }); seen.add(s); }
      }
    }
    if (token.endsWith("s") && token.length > 4) {
      const s = token.slice(0, -1);
      if (!seen.has(s)) { sources.push({ term: s, source: "singular" }); seen.add(s); }
    } else if (!token.endsWith("s") && token.length > 3) {
      const p = token + "s";
      if (!seen.has(p)) { sources.push({ term: p, source: "plural" }); seen.add(p); }
    }
  }

  const bounded = sources.length <= MAX_QUERY_EXPANSION_TERMS;
  return {
    originalQuery: query,
    expansionTerms: sources.map((s) => s.term),
    expansionSources: sources.slice(0, MAX_QUERY_EXPANSION_TERMS),
    bounded,
    limit: MAX_QUERY_EXPANSION_TERMS,
    count: Math.min(sources.length, MAX_QUERY_EXPANSION_TERMS),
    note: bounded
      ? "Expansion is within bounds"
      : `Expansion clamped to ${MAX_QUERY_EXPANSION_TERMS} terms`,
  };
}

/**
 * Preview expanded query without any writes (INV-QUAL8).
 */
export function previewExpandedQuery(query: string): {
  originalQuery: string;
  normalizedQuery: string;
  expandedTerms: string[];
  effectiveQuery: string;
  note: string;
} {
  const normalized = normalizeRetrievalQuery(query);
  const expandedTerms = buildQueryExpansionTerms(query);
  const effectiveQuery = expandedTerms.length > 0
    ? `${normalized} ${expandedTerms.join(" ")}`.trim()
    : normalized;
  return {
    originalQuery: query,
    normalizedQuery: normalized,
    expandedTerms,
    effectiveQuery,
    note: "Preview only — no writes performed (INV-QUAL8)",
  };
}

// ── LLM-assisted rewriting ────────────────────────────────────────────────────

const REWRITE_SYSTEM_PROMPT = `You are a search query optimization assistant. 
Rewrite the given user query to maximize document retrieval recall while preserving the original intent.

Rules:
- Keep the rewritten query concise (1-2 sentences max)
- Focus on retrieval-relevant terms  
- Do not add new factual claims
- Do not ask follow-up questions
- Output ONLY the rewritten query — no explanation`;

async function semanticRewriteQuery(
  query: string,
  modelName = "gpt-4o-mini",
): Promise<{ rewrittenQuery: string; latencyMs: number; fallbackUsed: boolean; fallbackReason: string | null }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { rewrittenQuery: "", latencyMs: 0, fallbackUsed: true, fallbackReason: "no_api_key" };
  }

  const client = new OpenAI({ apiKey, timeout: QUERY_REWRITE_TIMEOUT_MS });
  const startMs = Date.now();

  try {
    const response = await client.chat.completions.create({
      model: modelName,
      temperature: 0, // deterministic (INV-QUAL2)
      max_tokens: 150,
      messages: [
        { role: "system", content: REWRITE_SYSTEM_PROMPT },
        { role: "user", content: `Query: ${query}` },
      ],
    });

    const latencyMs = Date.now() - startMs;
    const rewrittenQuery = response.choices[0]?.message?.content?.trim() ?? "";
    return { rewrittenQuery, latencyMs, fallbackUsed: false, fallbackReason: null };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    const fallbackReason = msg.includes("timeout") || msg.includes("ETIMEDOUT")
      ? "provider_timeout"
      : "provider_error";
    return { rewrittenQuery: "", latencyMs, fallbackUsed: true, fallbackReason };
  }
}

// ── Main rewrite pipeline ─────────────────────────────────────────────────────

export interface RewriteParams {
  queryText: string;
  tenantId: string;
  enableSemanticRewrite?: boolean;
  modelName?: string;
}

/**
 * Full query rewrite pipeline (INV-QUAL1/2/3).
 * Always preserves originalQuery; never overwrites it.
 */
export async function rewriteRetrievalQuery(params: RewriteParams): Promise<QueryRewriteResult> {
  const startMs = Date.now();
  const {
    queryText,
    enableSemanticRewrite = QUERY_REWRITE_ENABLED,
    modelName = "gpt-4o-mini",
  } = params;

  const originalQuery = queryText; // INV-QUAL1: never mutated
  const normalizedQuery = normalizeRetrievalQuery(queryText);
  const expandedTerms = QUERY_EXPANSION_ENABLED ? buildQueryExpansionTerms(queryText) : [];

  // Determine if normalization actually changed anything
  const wasNormalized = normalizedQuery !== queryText.trim();
  const hasExpansion = expandedTerms.length > 0;

  if (!enableSemanticRewrite) {
    // Algorithmic path: no LLM call (INV-QUAL2: fully deterministic)
    let rewriteStrategy: RewriteStrategy;
    let rewrittenQuery: string;

    if (hasExpansion) {
      rewriteStrategy = "expand_and_rewrite";
      rewrittenQuery = `${normalizedQuery} ${expandedTerms.join(" ")}`.trim();
    } else if (wasNormalized) {
      rewriteStrategy = "normalize_only";
      rewrittenQuery = normalizedQuery;
    } else {
      rewriteStrategy = "passthrough";
      rewrittenQuery = normalizedQuery;
    }

    return {
      originalQuery,
      normalizedQuery,
      rewrittenQuery,
      expandedTerms,
      rewriteStrategy,
      latencyMs: Date.now() - startMs,
      fallbackUsed: false,
      fallbackReason: null,
      expansionCount: expandedTerms.length,
    };
  }

  // Semantic rewrite path (may fall back to algorithmic)
  const genResult = await semanticRewriteQuery(queryText, modelName);

  if (genResult.fallbackUsed || !genResult.rewrittenQuery) {
    // Fall back to expand_and_rewrite
    const rewrittenQuery = hasExpansion
      ? `${normalizedQuery} ${expandedTerms.join(" ")}`.trim()
      : normalizedQuery;
    return {
      originalQuery,
      normalizedQuery,
      rewrittenQuery,
      expandedTerms,
      rewriteStrategy: hasExpansion ? "expand_and_rewrite" : "normalize_only",
      latencyMs: Date.now() - startMs,
      fallbackUsed: true,
      fallbackReason: genResult.fallbackReason,
      expansionCount: expandedTerms.length,
    };
  }

  return {
    originalQuery,
    normalizedQuery,
    rewrittenQuery: genResult.rewrittenQuery,
    expandedTerms,
    rewriteStrategy: "semantic_rewrite",
    latencyMs: Date.now() - startMs,
    fallbackUsed: false,
    fallbackReason: null,
    expansionCount: expandedTerms.length,
  };
}

/**
 * Expand only (no LLM, pure algorithmic, INV-QUAL2/3/8).
 */
export async function expandRetrievalQuery(params: {
  queryText: string;
  tenantId?: string;
}): Promise<QueryRewriteResult> {
  return rewriteRetrievalQuery({
    queryText: params.queryText,
    tenantId: params.tenantId ?? "preview",
    enableSemanticRewrite: false,
  });
}

// ── Summarize / explain ───────────────────────────────────────────────────────

/**
 * Summarize a rewrite result for observability (INV-QUAL8: no writes).
 */
export function summarizeQueryRewrite(result: QueryRewriteResult): {
  originalQuery: string;
  rewrittenQuery: string;
  strategy: RewriteStrategy;
  expansionCount: number;
  latencyMs: number;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  note: string;
} {
  return {
    originalQuery: result.originalQuery,
    rewrittenQuery: result.rewrittenQuery,
    strategy: result.rewriteStrategy,
    expansionCount: result.expansionCount,
    latencyMs: result.latencyMs,
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason,
    note: `Strategy: ${result.rewriteStrategy}; ${result.expansionCount} expansion terms added`,
  };
}

/**
 * Explain query rewrite for a retrieval run (INV-QUAL8: no writes).
 * Returns a structured explanation based on the provided rewrite result.
 */
export function explainQueryRewrite(result: QueryRewriteResult): {
  stages: Array<{ stage: string; input: string; output: string; note: string }>;
  originalPreserved: boolean;
  note: string;
} {
  const stages = [
    {
      stage: "normalization",
      input: result.originalQuery,
      output: result.normalizedQuery,
      note: result.normalizedQuery === result.originalQuery.trim()
        ? "No normalization changes needed"
        : "Whitespace/unicode normalization applied",
    },
    {
      stage: "expansion",
      input: result.normalizedQuery,
      output: result.expandedTerms.length > 0 ? result.expandedTerms.join(", ") : "(none)",
      note: result.expandedTerms.length > 0
        ? `${result.expandedTerms.length} term(s) added via ${QUERY_EXPANSION_ENABLED ? "enabled" : "disabled"} expansion`
        : "No expansion terms added",
    },
    {
      stage: "rewrite",
      input: result.normalizedQuery,
      output: result.rewrittenQuery,
      note: result.fallbackUsed
        ? `Semantic rewrite fell back to ${result.rewriteStrategy} (reason: ${result.fallbackReason ?? "unknown"})`
        : `Strategy: ${result.rewriteStrategy}`,
    },
  ];

  return {
    stages,
    originalPreserved: true, // INV-QUAL1: always true
    note: "Read-only explanation. INV-QUAL8: no writes performed.",
  };
}
