/**
 * Phase 13 — Prompt Review Service
 * Manages the review workflow for prompt versions.
 * INV-PG4: Every prompt version requires a review before approval.
 * INV-PG5: Reviews are immutable — a new review must be created for changes.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "changes_requested";

export interface ReviewRecord {
  id: string;
  promptVersionId: string;
  reviewerId: string;
  reviewStatus: ReviewStatus;
  reviewNotes: string | null;
  createdAt: Date;
}

function rowToReview(r: Record<string, unknown>): ReviewRecord {
  return {
    id: r["id"] as string,
    promptVersionId: r["prompt_version_id"] as string,
    reviewerId: r["reviewer_id"] as string,
    reviewStatus: r["review_status"] as ReviewStatus,
    reviewNotes: (r["review_notes"] as string) ?? null,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── createReview ─────────────────────────────────────────────────────────────
export async function createReview(params: {
  promptVersionId: string;
  reviewerId: string;
  reviewStatus?: ReviewStatus;
  reviewNotes?: string;
}): Promise<ReviewRecord> {
  const { promptVersionId, reviewerId, reviewStatus = "pending", reviewNotes } = params;
  if (!promptVersionId || !reviewerId) throw new Error("INV-PG4: promptVersionId, reviewerId required");

  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.prompt_reviews (id,prompt_version_id,reviewer_id,review_status,review_notes)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4) RETURNING *`,
      [promptVersionId, reviewerId, reviewStatus, reviewNotes ?? null],
    );
    return rowToReview(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── updateReviewStatus ───────────────────────────────────────────────────────
// INV-PG5: Creates a new review entry rather than modifying existing.
export async function updateReviewStatus(params: {
  reviewId: string;
  reviewStatus: ReviewStatus;
  reviewNotes?: string;
}): Promise<ReviewRecord> {
  const client = getClient();
  await client.connect();
  try {
    // Get existing review
    const ex = await client.query(`SELECT * FROM public.prompt_reviews WHERE id=$1`, [params.reviewId]);
    if (!ex.rows.length) throw new Error(`Review ${params.reviewId} not found`);
    const existing = rowToReview(ex.rows[0]);

    // INV-PG5: Create a new review entry for the status change (immutability)
    const r = await client.query(
      `INSERT INTO public.prompt_reviews (id,prompt_version_id,reviewer_id,review_status,review_notes)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4) RETURNING *`,
      [existing.promptVersionId, existing.reviewerId, params.reviewStatus, params.reviewNotes ?? existing.reviewNotes],
    );
    return rowToReview(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── getLatestReview ──────────────────────────────────────────────────────────
export async function getLatestReview(promptVersionId: string): Promise<ReviewRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT * FROM public.prompt_reviews WHERE prompt_version_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [promptVersionId],
    );
    return r.rows.length ? rowToReview(r.rows[0]) : null;
  } finally {
    await client.end();
  }
}

// ─── listReviews ──────────────────────────────────────────────────────────────
export async function listReviews(promptVersionId: string): Promise<ReviewRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT * FROM public.prompt_reviews WHERE prompt_version_id=$1 ORDER BY created_at DESC`,
      [promptVersionId],
    );
    return r.rows.map(rowToReview);
  } finally {
    await client.end();
  }
}

// ─── isReviewPassed ───────────────────────────────────────────────────────────
export function isReviewPassed(review: ReviewRecord | null): boolean {
  return review?.reviewStatus === "approved";
}
