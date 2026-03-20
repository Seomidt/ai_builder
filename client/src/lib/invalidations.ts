/**
 * Centralized mutation invalidation matrix.
 *
 * All mutations across all pages must call these helpers instead of
 * writing inline invalidateQueries calls.
 *
 * Matrix:
 *   afterProjectMutation   → ["projects"], ["dashboard-summary"]
 *   afterRunMutation       → ["runs"], ["dashboard-summary"], optionally ["/api/runs", id]
 *   afterArchMutation      → ["architectures"], ["dashboard-summary"]
 *   afterIntegrationMutation → ["integrations"], ["dashboard-summary"]
 *
 * Rule: invalidate only what should change.
 * Dashboard summary is invalidated only when visible counts change.
 */

import { queryClient } from "./queryClient";

const _inv = (key: unknown[]) =>
  queryClient.invalidateQueries({ queryKey: key });

export const invalidate = {
  // ── Leaf invalidators ──────────────────────────────────────────────────────
  projects: () => _inv(["projects"]),

  /** Invalidates all runs queries regardless of filter (prefix match). */
  runs: () => _inv(["runs"]),

  /** Invalidates a specific run detail (stays on API route key). */
  runDetail: (id: string) => _inv(["/api/runs", id]),

  architectures: () => _inv(["architectures"]),

  integrations: () => _inv(["integrations"]),

  dashboard: () => _inv(["dashboard-summary"]),

  // ── Composed invalidators (use in mutations) ───────────────────────────────

  /** After project create / archive / update */
  afterProjectMutation: () =>
    Promise.all([_inv(["projects"]), _inv(["dashboard-summary"])]),

  /** After run create. Pass id to also refresh that run's detail. */
  afterRunCreate: (id?: string) => {
    const tasks: Promise<void>[] = [
      _inv(["runs"]),
      _inv(["dashboard-summary"]),
    ];
    if (id) tasks.push(_inv(["/api/runs", id]));
    return Promise.all(tasks);
  },

  /** After run status change (cancel, execute, status patch). */
  afterRunStatusChange: (id: string) =>
    Promise.all([_inv(["runs"]), _inv(["/api/runs", id])]),

  /** After architecture create / archive / update / version publish */
  afterArchMutation: () =>
    Promise.all([_inv(["architectures"]), _inv(["dashboard-summary"])]),

  /** After integration enable / disable / update */
  afterIntegrationMutation: () =>
    Promise.all([_inv(["integrations"]), _inv(["dashboard-summary"])]),
} as const;
