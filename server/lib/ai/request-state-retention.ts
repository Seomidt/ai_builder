/**
 * AI Request State Retention — Phase 3J
 *
 * SERVER-ONLY: Retention SQL foundation for expired ai_request_states rows
 * and related ai_request_state_events rows.
 *
 * This module does NOT run automatically. Cleanup must be triggered externally
 * (e.g. a scheduled admin script, a future cron job, or a manual Admin UI action).
 *
 * Retention design:
 *   ai_request_states rows expire 24 hours after creation (see schema.ts).
 *   Expired state rows are safe to delete — they will never be replayed or
 *   referenced by the idempotency layer once past expires_at.
 *
 *   ai_request_state_events rows are linked to requests by (tenant_id, request_id).
 *   They can be cleaned up after their parent state row expires, or on a fixed
 *   rolling window (e.g. 48 hours) for complete event audit trails.
 *
 * Batch approach: same oldest-first pattern as ai_response_cache retention.
 * Default batch: 5000 rows. Run in a loop until count = 0.
 *
 * Phase 3J.
 */

export const REQUEST_STATE_RETENTION_HOURS = 24;
export const REQUEST_STATE_EVENT_RETENTION_HOURS = 48;
export const REQUEST_STATE_CLEANUP_BATCH_SIZE = 5000;

// ── Preview SQL (read-only, safe to run any time) ─────────────────────────────

/**
 * Count expired ai_request_states rows.
 * Run before cleanup to estimate impact.
 */
export const PREVIEW_EXPIRED_STATES_SQL = `
SELECT COUNT(*) AS rows_to_delete
FROM ai_request_states
WHERE expires_at < NOW();
`.trim();

/**
 * Count old ai_request_state_events rows (48-hour window).
 */
export const PREVIEW_OLD_EVENTS_SQL = `
SELECT COUNT(*) AS rows_to_delete
FROM ai_request_state_events
WHERE created_at < NOW() - INTERVAL '${REQUEST_STATE_EVENT_RETENTION_HOURS} hours';
`.trim();

// ── Cleanup SQL (destructive — run deliberately) ──────────────────────────────

/**
 * Delete one batch of expired ai_request_states rows (oldest-first).
 * Uses subquery + LIMIT to avoid long-running transactions.
 *
 * Replace $1 with batch size (default: 5000).
 */
export const DELETE_EXPIRED_STATES_BATCH_SQL = `
DELETE FROM ai_request_states
WHERE id IN (
  SELECT id
  FROM ai_request_states
  WHERE expires_at < NOW()
  ORDER BY expires_at ASC
  LIMIT $1
);
`.trim();

/**
 * Delete one batch of old ai_request_state_events rows (oldest-first).
 * Replace $1 with batch size.
 */
export const DELETE_OLD_EVENTS_BATCH_SQL = `
DELETE FROM ai_request_state_events
WHERE id IN (
  SELECT id
  FROM ai_request_state_events
  WHERE created_at < NOW() - INTERVAL '${REQUEST_STATE_EVENT_RETENTION_HOURS} hours'
  ORDER BY created_at ASC
  LIMIT $1
);
`.trim();
