/**
 * KB Similar Cases Service — Storage 1.5
 *
 * Exposes "find similar cases" on top of the existing Storage 1.4 retrieval stack.
 * Three modes:
 *   - text  : embed a query string → vector-first similarity → lexical fallback
 *   - asset : compute centroid across all embeddings for that asset → similarity
 *   - chunk : use a specific chunk's embedding → similarity
 *
 * All modes:
 *   - tenant-safe (always scoped to tenantId)
 *   - expert-aware (expertId filters knowledge bases via expert_knowledge_bases)
 *   - de-duplicated (max MAX_CHUNKS_PER_ASSET chunks from same asset in results)
 *   - min-score threshold applied before returning
 *   - source-attributed (chunk + asset + knowledge base metadata in each result)
 *   - chat-ready (snippet, sourceLabel, whyMatched, assetType fields)
 *
 * Does NOT duplicate any storage/embedding infrastructure.
 * Reuses pgvector column + HNSW index from Storage 1.4.
 */

import pg from "pg";
import { generateQueryEmbedding } from "./kb-embeddings.ts";
import {
  resolveMinScore,
  deriveWhyMatchedCode,
  deriveConfidenceCode,
  type WhyMatchedCode,
  type SimilarConfidenceCode,
} from "./similarity-control";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single similar case result — source-attributed and chat-ready.
 */
export interface SimilarCase {
  // ── Retrieval identity ──────────────────────────────────────────────────────
  chunkId:          string;
  score:            number;             // 0.0–1.0 cosine similarity
  retrievalChannel: "vector" | "lexical" | "hybrid";

  // ── Chat-ready fields ───────────────────────────────────────────────────────
  snippet:          string;             // first 500 chars of chunk text
  whyMatchedCode:   WhyMatchedCode;     // locale-safe: "vector_match" | "lexical_match" | "hybrid_match"
  confidenceCode:   SimilarConfidenceCode; // locale-safe: "high" | "medium" | "low" | "unknown"
  sourceLabel:      string;             // human-readable: "<kbName> / <assetTitle>"

  // ── Asset attribution ───────────────────────────────────────────────────────
  assetId:          string;             // knowledge_document id
  assetVersionId:   string;             // knowledge_document_version id
  assetTitle:       string | null;      // document title
  assetType:        string | null;      // document | image | video
  mimeType:         string | null;
  fileName:         string | null;      // original_filename if available
  fileSizeBytes:    number | null;

  // ── Source attribution ──────────────────────────────────────────────────────
  kbId:             string;             // knowledge_base id
  kbName:           string | null;      // knowledge base name

  // ── Position (extensible) ───────────────────────────────────────────────────
  // Populated if metadata is stored on the chunk; null otherwise.
  pageNumber:       number | null;      // for documents
  timestampSec:     number | null;      // for video/audio transcripts
}

/**
 * Full response envelope for /api/kb/similar.
 */
export interface SimilarCasesResult {
  cases:  SimilarCase[];
  total:  number;
  debug:  SimilarCasesDebug;
}

export interface SimilarCasesDebug {
  mode:            "text" | "asset" | "chunk";
  retrievalPath:   "vector_pgvector" | "vector_appside" | "lexical" | "empty";
  pgvectorUsed:    boolean;
  expertFiltered:  boolean;
  kbFiltered:      boolean;
  minScore:        number;
  hasQueryVector:  boolean;
  candidateCount:  number;   // raw results before dedup/threshold
  returnedCount:   number;   // final results returned
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CHUNKS_PER_ASSET  = 2;    // max chunks from same asset in results
const DEFAULT_TOP_K         = 10;
const MAX_TOP_K             = 50;

// ── Min-score thresholds ─────────────────────────────────────────────────────
// Thresholds are now owned by similarity-control.ts (resolveMinScore).
// Do NOT re-declare defaults here — use resolveMinScore(channel) directly.

const SNIPPET_CHARS = 500;  // max chars in snippet

// ─── DB client ───────────────────────────────────────────────────────────────

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── pgvector column cache ────────────────────────────────────────────────────

let _pgvAvail: boolean | null = null;

async function pgvAvailable(client: pg.Client): Promise<boolean> {
  if (_pgvAvail !== null) return _pgvAvail;
  const r = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='knowledge_embeddings'
      AND column_name='embedding_vector_pgv' LIMIT 1`);
  _pgvAvail = r.rows.length > 0;
  return _pgvAvail;
}

// ─── Expert KB resolver ───────────────────────────────────────────────────────

async function resolveExpertKbs(
  client: pg.Client,
  tenantId: string,
  expertId: string,
): Promise<string[]> {
  const r = await client.query(
    `SELECT knowledge_base_id FROM expert_knowledge_bases
     WHERE tenant_id=$1 AND expert_id=$2`,
    [tenantId, expertId],
  );
  return r.rows.map((row: Record<string, string>) => row["knowledge_base_id"]);
}

// ─── Result shaping ───────────────────────────────────────────────────────────

/**
 * Rich query that returns source-attributed rows.
 * Used by all three similarity modes — caller supplies the ORDER/LIMIT strategy.
 */
const RICH_SELECT = `
  SELECT
    kc.id                            AS chunk_id,
    kc.knowledge_base_id             AS kb_id,
    kc.knowledge_document_id         AS doc_id,
    kc.knowledge_document_version_id AS version_id,
    kc.chunk_text,
    kc.metadata                      AS chunk_meta,
    kd.title                         AS asset_title,
    kd.document_type                 AS asset_type,
    kd.mime_type,
    kd.original_filename             AS file_name,
    kd.file_size_bytes,
    kb.name                          AS kb_name
`;

const RICH_JOINS = `
  INNER JOIN knowledge_embeddings ke
          ON ke.knowledge_chunk_id   = kc.id
         AND ke.tenant_id            = kc.tenant_id
         AND ke.embedding_status     = 'completed'
  INNER JOIN knowledge_documents kd
          ON kd.id = kc.knowledge_document_id
         AND kd.document_status IN ('ready', 'active')
  INNER JOIN knowledge_bases kb
          ON kb.id        = kc.knowledge_base_id
         AND kb.tenant_id = kc.tenant_id
`;

/**
 * Extract a smart snippet that highlights relevant context.
 * If queryText is available, try to center around it.
 * Otherwise fall back to first N chars.
 */
function extractSmartSnippet(
  fullText: string,
  queryText?: string,
): string {
  if (!fullText) return "";

  const text = String(fullText);
  if (text.length <= SNIPPET_CHARS) return text;

  // If we have a query, try to find it in the text and build snippet around it
  if (queryText && queryText.trim().length > 0) {
    const searchTerms = queryText.trim().toLowerCase().split(/\s+/).filter(t => t.length > 3);
    if (searchTerms.length > 0) {
      const lowerText = text.toLowerCase();
      for (const term of searchTerms) {
        const idx = lowerText.indexOf(term);
        if (idx !== -1) {
          // Center snippet around this match
          const start = Math.max(0, idx - 150);
          const end = Math.min(text.length, start + SNIPPET_CHARS);
          const snippet = text.slice(start, end).trim();
          // Prefix "..." if truncated at start
          return (start > 0 ? "..." : "") + snippet + (end < text.length ? "..." : "");
        }
      }
    }
  }

  // Fallback: first 500 chars with "..." if truncated
  const snippet = text.slice(0, SNIPPET_CHARS).trim();
  return snippet + (text.length > SNIPPET_CHARS ? "..." : "");
}

/**
 * Apply minScore thresholding — delegates to control layer.
 * Tenant overrides can be passed as the optional third argument.
 */
function shouldIncludeResult(
  score: number,
  channel: "vector" | "lexical" | "hybrid",
): boolean {
  return score >= resolveMinScore(channel);
}

function rowToSimilarCase(
  r: Record<string, unknown>,
  scoreVector: number,
  scoreLexical: number,
  channel: "vector" | "lexical" | "hybrid",
  queryText?: string,
): SimilarCase {
  const score = channel === "lexical" ? scoreLexical : scoreVector;

  // Parse position metadata if present
  const meta = r["chunk_meta"] as Record<string, unknown> | null | undefined;
  const pageNumber    = typeof meta?.["page"]      === "number" ? meta["page"]      as number : null;
  const timestampSec  = typeof meta?.["timestamp"] === "number" ? meta["timestamp"] as number : null;

  const kbName     = (r["kb_name"]    as string | null) ?? null;
  const assetTitle = (r["asset_title"] as string | null) ?? null;
  const sourceLabel = [kbName, assetTitle].filter(Boolean).join(" / ") || "";

  const clampedScore    = Math.max(0, Math.min(1, score));
  const whyMatchedCode  = deriveWhyMatchedCode(channel);
  const confidenceCode  = deriveConfidenceCode(clampedScore, channel);

  const chunkText = String(r["chunk_text"] ?? "");
  const snippet = extractSmartSnippet(chunkText, queryText);

  return {
    chunkId:          r["chunk_id"]    as string,
    score:            clampedScore,
    retrievalChannel: channel,
    snippet,
    whyMatchedCode,
    confidenceCode,
    sourceLabel,
    assetId:          r["doc_id"]      as string,
    assetVersionId:   r["version_id"]  as string,
    assetTitle,
    assetType:        (r["asset_type"] as string | null) ?? null,
    mimeType:         (r["mime_type"]  as string | null) ?? null,
    fileName:         (r["file_name"]  as string | null) ?? null,
    fileSizeBytes:    r["file_size_bytes"] != null ? Number(r["file_size_bytes"]) : null,
    kbId:             r["kb_id"]       as string,
    kbName,
    pageNumber,
    timestampSec,
  };
}

// ─── De-duplication ───────────────────────────────────────────────────────────

function deduplicateByAsset(cases: SimilarCase[], maxPerAsset: number): SimilarCase[] {
  const counts = new Map<string, number>();
  const out: SimilarCase[] = [];
  for (const c of cases) {
    const n = counts.get(c.assetId) ?? 0;
    if (n < maxPerAsset) {
      out.push(c);
      counts.set(c.assetId, n + 1);
    }
  }
  return out;
}

// ─── Mode: text-query similarity ─────────────────────────────────────────────

async function findSimilarByText(params: {
  client:       pg.Client;
  tenantId:     string;
  queryText:    string;
  allowedKbIds: string[] | null;
  safeTopK:     number;
  minScore:     number;
  excludeAssetId?: string;
}): Promise<{ cases: SimilarCase[]; path: SimilarCasesDebug["retrievalPath"]; pgvUsed: boolean; hasVec: boolean }> {
  const { client, tenantId, queryText, allowedKbIds, safeTopK, minScore, excludeAssetId } = params;

  const queryVec  = await generateQueryEmbedding(queryText);
  const pgvReady  = await pgvAvailable(client);

  const kbFilter      = allowedKbIds?.length ? `AND kc.knowledge_base_id = ANY($${queryVec ? 3 : 2}::text[])` : "";
  const excludeFilter = excludeAssetId ? `AND kc.knowledge_document_id != '${excludeAssetId.replace(/'/g, "''")}'` : "";

  if (queryVec && pgvReady) {
    // Vector path
    const vecStr = `[${queryVec.join(",")}]`;
    const values: unknown[] = allowedKbIds?.length
      ? [tenantId, vecStr, allowedKbIds, safeTopK * 3]
      : [tenantId, vecStr, safeTopK * 3];
    const limitP = allowedKbIds?.length ? 4 : 3;

    const r = await client.query(
      `${RICH_SELECT},
         1 - (ke.embedding_vector_pgv <=> $2::vector) AS score_vector
       FROM knowledge_chunks kc
       ${RICH_JOINS}
       WHERE kc.tenant_id    = $1
         AND kc.chunk_active = TRUE
         AND ke.embedding_vector_pgv IS NOT NULL
         ${kbFilter}
         ${excludeFilter}
       ORDER BY ke.embedding_vector_pgv <=> $2::vector ASC
       LIMIT $${limitP}`,
      values,
    );

    const cases = (r.rows as Array<Record<string, unknown>>)
      .map((row) => rowToSimilarCase(row, Number(row["score_vector"]), 0, "vector", queryText))
      .filter((c) => shouldIncludeResult(c.score, c.retrievalChannel));

    return { cases, path: "vector_pgvector", pgvUsed: true, hasVec: true };
  }

  if (queryVec && !pgvReady) {
    // App-side cosine fallback
    const values: unknown[] = allowedKbIds?.length ? [tenantId, allowedKbIds] : [tenantId];
    const kbF2 = allowedKbIds?.length ? `AND kc.knowledge_base_id = ANY($2::text[])` : "";

    const r = await client.query(
      `${RICH_SELECT}, ke.embedding_vector
       FROM knowledge_chunks kc
       ${RICH_JOINS}
       WHERE kc.tenant_id    = $1
         AND kc.chunk_active = TRUE
         AND ke.embedding_vector IS NOT NULL
         ${kbF2}
         ${excludeFilter}
       LIMIT 2000`,
      values,
    );

    const { cosineSimilarity } = await import("./kb-embeddings");
    const cases = (r.rows as Array<Record<string, unknown>>)
      .map((row) => {
        const sim = cosineSimilarity(queryVec, row["embedding_vector"] as number[]);
        return rowToSimilarCase(row, sim, 0, "vector", queryText);
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, safeTopK * 3)
      .filter((c) => shouldIncludeResult(c.score, c.retrievalChannel));

    return { cases, path: "vector_appside", pgvUsed: false, hasVec: true };
  }

  // Lexical-only fallback
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm").catch(() => {});

  const values: unknown[] = allowedKbIds?.length
    ? [tenantId, queryText.slice(0, 2000), safeTopK * 3, allowedKbIds]
    : [tenantId, queryText.slice(0, 2000), safeTopK * 3];
  const kbF3 = allowedKbIds?.length ? `AND kc.knowledge_base_id = ANY($4::text[])` : "";

  const r = await client.query(
    `${RICH_SELECT},
       LEAST(1.0, GREATEST(0.0,
         COALESCE(SIMILARITY(kc.chunk_text,$2),0)*0.6
         + COALESCE(ts_rank(to_tsvector('english',kc.chunk_text),plainto_tsquery('english',$2),32)*2,0)
       )) AS score_text
     FROM knowledge_chunks kc
     ${RICH_JOINS}
     WHERE kc.tenant_id    = $1
       AND kc.chunk_active = TRUE
       ${kbF3}
       ${excludeFilter}
     ORDER BY score_text DESC
     LIMIT $3`,
    values,
  );

  const cases = (r.rows as Array<Record<string, unknown>>)
    .map((row) => rowToSimilarCase(row, 0, Number(row["score_text"]), "lexical", queryText))
    .filter((c) => shouldIncludeResult(c.score, c.retrievalChannel));

  return { cases, path: "lexical", pgvUsed: false, hasVec: false };
}

// ─── Mode: asset-based similarity ────────────────────────────────────────────

async function findSimilarByAsset(params: {
  client:       pg.Client;
  tenantId:     string;
  assetId:      string;
  allowedKbIds: string[] | null;
  safeTopK:     number;
  minScore:     number;
}): Promise<{ cases: SimilarCase[]; path: SimilarCasesDebug["retrievalPath"]; pgvUsed: boolean; hasVec: boolean }> {
  const { client, tenantId, assetId, allowedKbIds, safeTopK, minScore } = params;

  const pgvReady = await pgvAvailable(client);

  if (pgvReady) {
    // Compute centroid embedding across all chunks of this asset
    const centRes = await client.query(
      `SELECT avg(embedding_vector_pgv) AS centroid
       FROM knowledge_embeddings
       WHERE tenant_id              = $1
         AND knowledge_document_id  = $2
         AND embedding_status       = 'completed'
         AND embedding_vector_pgv   IS NOT NULL`,
      [tenantId, assetId],
    );
    const centroid = centRes.rows[0]?.["centroid"] as string | null;

    if (!centroid) {
      // Asset has no embeddings yet — fall through to title-based lexical
      const docRes = await client.query(
        `SELECT title FROM knowledge_documents WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [assetId, tenantId],
      );
      const title = docRes.rows[0]?.["title"] as string | null;
      if (!title) return { cases: [], path: "empty", pgvUsed: false, hasVec: false };
      return findSimilarByText({ client, tenantId, queryText: title, allowedKbIds, safeTopK, minScore, excludeAssetId: assetId });
    }

    const kbFilter = allowedKbIds?.length ? `AND kc.knowledge_base_id = ANY($3::text[])` : "";
    const values: unknown[] = allowedKbIds?.length
      ? [tenantId, centroid, allowedKbIds, safeTopK * 3, assetId]
      : [tenantId, centroid, safeTopK * 3, assetId];
    const limitP    = allowedKbIds?.length ? 4 : 3;
    const excludeP  = allowedKbIds?.length ? 5 : 4;

    const r = await client.query(
      `${RICH_SELECT},
         1 - (ke.embedding_vector_pgv <=> $2::vector) AS score_vector
       FROM knowledge_chunks kc
       ${RICH_JOINS}
       WHERE kc.tenant_id              = $1
         AND kc.chunk_active           = TRUE
         AND kc.knowledge_document_id != $${excludeP}
         AND ke.embedding_vector_pgv   IS NOT NULL
         ${kbFilter}
       ORDER BY ke.embedding_vector_pgv <=> $2::vector ASC
       LIMIT $${limitP}`,
      values,
    );

    const cases = (r.rows as Array<Record<string, unknown>>)
      .map((row) => rowToSimilarCase(row, Number(row["score_vector"]), 0, "vector"))
      .filter((c) => shouldIncludeResult(c.score, c.retrievalChannel));

    return { cases, path: "vector_pgvector", pgvUsed: true, hasVec: true };
  }

  // pgvector not available — fall back to title-based lexical
  const docRes = await client.query(
    `SELECT title FROM knowledge_documents WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
    [assetId, tenantId],
  );
  const title = docRes.rows[0]?.["title"] as string | null;
  if (!title) return { cases: [], path: "empty", pgvUsed: false, hasVec: false };
  return findSimilarByText({ client, tenantId, queryText: title, allowedKbIds, safeTopK, minScore, excludeAssetId: assetId });
}

// ─── Mode: chunk-based similarity ────────────────────────────────────────────

async function findSimilarByChunk(params: {
  client:       pg.Client;
  tenantId:     string;
  chunkId:      string;
  allowedKbIds: string[] | null;
  safeTopK:     number;
  minScore:     number;
}): Promise<{ cases: SimilarCase[]; path: SimilarCasesDebug["retrievalPath"]; pgvUsed: boolean; hasVec: boolean }> {
  const { client, tenantId, chunkId, allowedKbIds, safeTopK, minScore } = params;

  const pgvReady = await pgvAvailable(client);

  if (pgvReady) {
    // Get the embedding vector of this specific chunk
    const embRes = await client.query(
      `SELECT embedding_vector_pgv, knowledge_document_id
       FROM knowledge_embeddings
       WHERE knowledge_chunk_id = $1
         AND tenant_id          = $2
         AND embedding_status   = 'completed'
         AND embedding_vector_pgv IS NOT NULL
       LIMIT 1`,
      [chunkId, tenantId],
    );
    const embRow = embRes.rows[0] as Record<string, unknown> | undefined;
    if (!embRow) {
      // No embedding — fall back to the chunk text for lexical
      const chunkRes = await client.query(
        `SELECT chunk_text, knowledge_document_id FROM knowledge_chunks WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
        [chunkId, tenantId],
      );
      const row = chunkRes.rows[0] as Record<string, unknown> | undefined;
      if (!row) return { cases: [], path: "empty", pgvUsed: false, hasVec: false };
      return findSimilarByText({
        client, tenantId,
        queryText: String(row["chunk_text"] ?? "").slice(0, 1000),
        allowedKbIds, safeTopK, minScore,
        excludeAssetId: row["knowledge_document_id"] as string,
      });
    }

    const chunkVec     = embRow["embedding_vector_pgv"] as string;
    const excludeDocId = embRow["knowledge_document_id"] as string;

    const kbFilter = allowedKbIds?.length ? `AND kc.knowledge_base_id = ANY($3::text[])` : "";
    const values: unknown[] = allowedKbIds?.length
      ? [tenantId, chunkVec, allowedKbIds, safeTopK * 3]
      : [tenantId, chunkVec, safeTopK * 3];
    const limitP = allowedKbIds?.length ? 4 : 3;

    const r = await client.query(
      `${RICH_SELECT},
         1 - (ke.embedding_vector_pgv <=> $2::vector) AS score_vector
       FROM knowledge_chunks kc
       ${RICH_JOINS}
       WHERE kc.tenant_id              = $1
         AND kc.chunk_active           = TRUE
         AND kc.id                    != '${chunkId.replace(/'/g, "''")}'
         AND kc.knowledge_document_id != '${excludeDocId.replace(/'/g, "''")}'
         AND ke.embedding_vector_pgv   IS NOT NULL
         ${kbFilter}
       ORDER BY ke.embedding_vector_pgv <=> $2::vector ASC
       LIMIT $${limitP}`,
      values,
    );

    const cases = (r.rows as Array<Record<string, unknown>>)
      .map((row) => rowToSimilarCase(row, Number(row["score_vector"]), 0, "vector"))
      .filter((c) => shouldIncludeResult(c.score, c.retrievalChannel));

    return { cases, path: "vector_pgvector", pgvUsed: true, hasVec: true };
  }

  // Fallback — use chunk text for lexical
  const chunkRes = await client.query(
    `SELECT chunk_text, knowledge_document_id FROM knowledge_chunks WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
    [chunkId, tenantId],
  );
  const row = chunkRes.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { cases: [], path: "empty", pgvUsed: false, hasVec: false };
  return findSimilarByText({
    client, tenantId,
    queryText: String(row["chunk_text"] ?? "").slice(0, 1000),
    allowedKbIds, safeTopK, minScore,
    excludeAssetId: row["knowledge_document_id"] as string,
  });
}

// ─── Public entry point ───────────────────────────────────────────────────────

export type SimilarCasesMode = "text" | "asset" | "chunk";

export interface SimilarCasesParams {
  tenantId:  string;
  mode:      SimilarCasesMode;

  // Mode-specific input (one of the following must be provided)
  queryText?: string;   // for mode="text"
  assetId?:   string;   // for mode="asset"
  chunkId?:   string;   // for mode="chunk"

  // Filters
  kbId?:      string;   // restrict to single KB
  kbIds?:     string[]; // restrict to multiple KBs (merged with kbId if both)
  expertId?:  string;   // restrict to KBs linked to this expert

  // Quality controls
  topK?:      number;   // default 10, max 50
  minScore?:  number;   // default 0.10
}

export async function findSimilarCases(params: SimilarCasesParams): Promise<SimilarCasesResult> {
  const {
    tenantId, mode,
    queryText, assetId, chunkId,
    kbId, kbIds, expertId,
    topK = DEFAULT_TOP_K,
    minScore = 0,  // Kept for API compat; actual thresholds are per-channel via shouldIncludeResult()
  } = params;

  const safeTopK = Math.min(Math.max(1, topK), MAX_TOP_K);
  const safeScore = Math.max(0, Math.min(1, minScore)); // For API compat only

  const client = getClient();
  await client.connect();

  try {
    // ── Resolve allowed KB IDs ───────────────────────────────────────────────
    let allowedKbIds: string[] | null = null;

    // Explicit KB filters
    const explicitKbs: string[] = [
      ...(kbId ? [kbId] : []),
      ...(kbIds ?? []),
    ];

    if (expertId) {
      const expertKbs = await resolveExpertKbs(client, tenantId, expertId);
      if (expertKbs.length === 0) {
        // Expert has no KBs — return empty immediately
        return {
          cases: [],
          total: 0,
          debug: {
            mode, retrievalPath: "empty", pgvectorUsed: false,
            expertFiltered: true, kbFiltered: explicitKbs.length > 0,
            minScore: safeScore, hasQueryVector: false,
            candidateCount: 0, returnedCount: 0,
          },
        };
      }
      allowedKbIds = explicitKbs.length
        ? expertKbs.filter((id) => explicitKbs.includes(id))
        : expertKbs;
    } else if (explicitKbs.length) {
      allowedKbIds = explicitKbs;
    }

    // ── Dispatch to mode handler ─────────────────────────────────────────────
    let result: { cases: SimilarCase[]; path: SimilarCasesDebug["retrievalPath"]; pgvUsed: boolean; hasVec: boolean };

    if (mode === "text") {
      if (!queryText?.trim()) throw new Error("queryText is required for mode=text");
      result = await findSimilarByText({ client, tenantId, queryText: queryText.trim(), allowedKbIds, safeTopK, minScore: safeScore });

    } else if (mode === "asset") {
      if (!assetId?.trim()) throw new Error("assetId is required for mode=asset");
      result = await findSimilarByAsset({ client, tenantId, assetId: assetId.trim(), allowedKbIds, safeTopK, minScore: safeScore });

    } else {
      if (!chunkId?.trim()) throw new Error("chunkId is required for mode=chunk");
      result = await findSimilarByChunk({ client, tenantId, chunkId: chunkId.trim(), allowedKbIds, safeTopK, minScore: safeScore });
    }

    const candidateCount = result.cases.length;

    // ── De-duplicate and slice ───────────────────────────────────────────────
    const deduped = deduplicateByAsset(result.cases, MAX_CHUNKS_PER_ASSET);
    const final   = deduped
      .sort((a, b) => b.score - a.score)
      .slice(0, safeTopK);

    return {
      cases: final,
      total: final.length,
      debug: {
        mode,
        retrievalPath:  result.path,
        pgvectorUsed:   result.pgvUsed,
        expertFiltered: !!expertId,
        kbFiltered:     allowedKbIds !== null,
        minScore:       safeScore,
        hasQueryVector: result.hasVec,
        candidateCount,
        returnedCount:  final.length,
      },
    };
  } finally {
    await client.end().catch(() => {});
  }
}
