/**
 * App-wide query policy matrix.
 *
 * All tenant pages must use one of these categories.
 * Never define ad-hoc staleTime / retry / refetchInterval per page.
 *
 * Categories:
 *   staticList   — projects, architectures, integrations
 *   semiLive     — runs list (bounded polling)
 *   dashboard    — dashboard summary
 *   detail       — detail pages (stable content)
 *   detailLive   — run detail when status is pending/running
 */

export const QUERY_POLICY = {
  /**
   * A. Static-ish lists — projects, architectures, integrations.
   * Mutate → explicit invalidation. No background polling.
   */
  staticList: {
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: false as const,
  },

  /**
   * B. Semi-live operational list — runs.
   * Bounded polling every 5s. Short staleTime so refetch fires promptly.
   */
  semiLive: {
    staleTime: 4_000,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 5_000,
  },

  /**
   * C. Dashboard summary.
   * Moderate stale window — refreshed by mutations and on focus.
   */
  dashboard: {
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  },

  /**
   * D. Detail pages — stable content, single-record reads.
   * No polling; refreshed by targeted invalidation after mutations.
   */
  detail: {
    staleTime: 15_000,
    gcTime: 3 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: false as const,
  },

  /**
   * D-live. Run detail when run is pending/running.
   * Dynamic refetchInterval (2s); computed via callback in the page.
   */
  detailLive: {
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  },
} as const;

/** Stable limit sizes per category */
export const PAGE_LIMIT = {
  staticList: 50,
  runs: 50,
  integrations: 20,
} as const;
