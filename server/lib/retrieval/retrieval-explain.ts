/**
 * Phase 11 — Retrieval Explain Service
 * INV-RET12: explainRetrieval must be read-only — no writes permitted.
 * Returns full observability for a retrieval run: hits, weights, ordering.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export interface RetrievalExplanation {
  queryId: string;
  tenantId: string;
  queryText: string;
  strategy: string;
  topK: number;
  rankingWeights: { vector: number; lexical: number };
  vectorHits: number;
  lexicalHits: number;
  totalResults: number;
  latencyMs: number;
  results: Array<{
    rankPosition: number;
    chunkId: string;
    scoreVector: number;
    scoreLexical: number;
    scoreCombined: number;
    documentId: string;
    contentPreview: string;
  }>;
  note: string;
}

// ─── explainRetrieval ─────────────────────────────────────────────────────────
// INV-RET12: Read-only. No INSERT / UPDATE / DELETE.

export async function explainRetrieval(queryId: string, tenantId: string): Promise<RetrievalExplanation | null> {
  const client = getClient();
  await client.connect();

  try {
    // All reads — no writes (INV-RET12)
    const [queryRow, resultsRow, metricsRow] = await Promise.all([
      client.query(`SELECT * FROM public.retrieval_queries WHERE id = $1 AND tenant_id = $2`, [queryId, tenantId]),
      client.query(
        `SELECT * FROM public.retrieval_results WHERE query_id = $1 ORDER BY rank_position ASC`,
        [queryId],
      ),
      client.query(
        `SELECT * FROM public.retrieval_query_metrics WHERE query_id = $1 AND tenant_id = $2`,
        [queryId, tenantId],
      ),
    ]);

    if (queryRow.rows.length === 0) return null;

    const q = queryRow.rows[0];
    const strategy = q.retrieval_strategy as string;
    const rankingWeights = strategy === "vector" ? { vector: 1.0, lexical: 0.0 }
      : strategy === "lexical" ? { vector: 0.0, lexical: 1.0 }
      : { vector: 0.7, lexical: 0.3 };

    const metrics = metricsRow.rows[0];

    // Fetch content preview per chunk (read-only)
    const chunkIds = resultsRow.rows.map((r) => r.chunk_id as string);
    let contentMap: Map<string, string> = new Map();
    if (chunkIds.length > 0) {
      const chunkR = await client.query(
        `SELECT id, LEFT(content, 150) as preview FROM public.ingestion_chunks WHERE id = ANY($1) AND tenant_id = $2`,
        [chunkIds, tenantId],
      );
      for (const c of chunkR.rows) contentMap.set(c.id as string, c.preview as string);
    }

    const results = resultsRow.rows.map((r) => ({
      rankPosition: r["rank_position"] as number,
      chunkId: r["chunk_id"] as string,
      scoreVector: parseFloat((r["score_vector"] ?? 0).toString()),
      scoreLexical: parseFloat((r["score_lexical"] ?? 0).toString()),
      scoreCombined: parseFloat((r["score_combined"] ?? 0).toString()),
      documentId: r["query_id"] as string,
      contentPreview: contentMap.get(r["chunk_id"] as string) ?? "",
    }));

    return {
      queryId,
      tenantId,
      queryText: q.query_text as string,
      strategy,
      topK: q.top_k as number,
      rankingWeights,
      vectorHits: metrics ? (metrics.vector_hits as number) : 0,
      lexicalHits: metrics ? (metrics.lexical_hits as number) : 0,
      totalResults: results.length,
      latencyMs: metrics ? (metrics.latency_ms as number) : 0,
      results,
      note: "INV-RET12: Read-only — no writes performed.",
    };
  } finally {
    await client.end();
  }
}
