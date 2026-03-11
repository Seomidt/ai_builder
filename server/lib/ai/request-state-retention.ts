/**
 * AI Request State Retention — Phase 3J.1
 *
 * SERVER-ONLY: Retention SQL foundation for expired ai_request_states rows
 * and old ai_request_state_events rows.
 *
 * This module does NOT run automatically. Cleanup must be triggered externally
 * (e.g. a scheduled admin script, a future cron job, or a manual Admin UI action).
 *
 * ── Retention policy ──────────────────────────────────────────────────────────
 *
 * ai_request_states — expires_at-based:
 *   Delete rows where expires_at < NOW().
 *   Rationale: expires_at already represents the idempotency lifetime boundary.
 *   Once expired, state is no longer needed for replay or duplicate detection.
 *   New execution of the same request_id starts fresh after expiry.
 *   TTL is set to 24 hours at write time (see idempotency.ts).
 *
 * ai_request_state_events — created_at-based (30-day window):
 *   Delete rows where created_at < NOW() - INTERVAL '30 days'.
 *   Rationale: events are admin/debug audit logs. 30 days covers:
 *     - all realistic incident investigation windows
 *     - 2+ billing/analysis cycles for pattern detection
 *     - admin review of duplicate storms or abuse patterns
 *   Events are append-only and have no runtime dependency — safe to delete
 *   once they fall outside the 30-day audit window.
 *
 * ── Index support (verified in live DB, Phase 3J) ────────────────────────────
 *
 * Both cleanup queries use indexed columns:
 *   ai_request_states_expires_idx   ON ai_request_states(expires_at)
 *   ai_request_state_events_created_at_idx  ON ai_request_state_events(created_at)
 *
 * No additional indexes needed — Phase 3J already provisioned both.
 *
 * Phase 3J.1.
 */

/** Retention window constants */
export const REQUEST_STATE_RETENTION_HOURS = 24;      // Matches TTL set in idempotency.ts
export const REQUEST_STATE_EVENT_RETENTION_DAYS = 30; // Admin/debug audit window

// ── ai_request_states: Preview SQL ───────────────────────────────────────────

/**
 * Count expired ai_request_states rows that are eligible for deletion.
 * Safe to run at any time — read-only.
 *
 * Uses: ai_request_states_expires_idx (btree on expires_at)
 */
export const PREVIEW_EXPIRED_STATES_SQL = `
SELECT COUNT(*) AS rows_to_delete
FROM ai_request_states
WHERE expires_at < NOW();
`.trim();

// ── ai_request_states: Cleanup SQL ───────────────────────────────────────────

/**
 * Delete all expired ai_request_states rows in a single statement.
 * Run after PREVIEW_EXPIRED_STATES_SQL to confirm scope.
 *
 * Safe to run at any time — expired rows are never consulted by the runtime:
 *   - idempotency.ts beginAiRequest() inserts new rows for new/retried executions
 *   - replay only works on non-expired completed rows
 *   - inflight detection only fires on in_progress rows within TTL
 *
 * Uses: ai_request_states_expires_idx (btree on expires_at)
 */
export const DELETE_EXPIRED_STATES_SQL = `
DELETE FROM ai_request_states
WHERE expires_at < NOW();
`.trim();

// ── ai_request_state_events: Preview SQL ─────────────────────────────────────

/**
 * Count ai_request_state_events rows older than 30 days.
 * Safe to run at any time — read-only.
 *
 * Uses: ai_request_state_events_created_at_idx (btree on created_at)
 */
export const PREVIEW_OLD_EVENTS_SQL = `
SELECT COUNT(*) AS rows_to_delete
FROM ai_request_state_events
WHERE created_at < NOW() - INTERVAL '${REQUEST_STATE_EVENT_RETENTION_DAYS} days';
`.trim();

// ── ai_request_state_events: Cleanup SQL ─────────────────────────────────────

/**
 * Delete ai_request_state_events rows older than 30 days.
 * Run after PREVIEW_OLD_EVENTS_SQL to confirm scope.
 *
 * Events are append-only observability rows with no runtime dependency.
 * Deleting them does not affect:
 *   - idempotency behavior
 *   - replay behavior
 *   - duplicate detection
 *   - request tracing for current in-flight or recent requests
 *
 * Uses: ai_request_state_events_created_at_idx (btree on created_at)
 */
export const DELETE_OLD_EVENTS_SQL = `
DELETE FROM ai_request_state_events
WHERE created_at < NOW() - INTERVAL '${REQUEST_STATE_EVENT_RETENTION_DAYS} days';
`.trim();
