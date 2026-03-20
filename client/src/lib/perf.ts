/**
 * Lightweight client-side performance observability.
 *
 * Dev-only. Zero production overhead (all guarded by import.meta.env.DEV).
 * Writes structured entries to sessionStorage["blissops_perf"] and logs to console.
 *
 * Usage:
 *   const perf = usePagePerf("projects");
 *   // In useEffect when data changes:
 *   perf.record(data?.pages.flatMap(p => p.items).length ?? 0, isFromCache);
 */

import { useRef, useCallback } from "react";

interface PerfEntry {
  page: string;
  ts: string;
  durationMs: number;
  items: number;
  fromCache: boolean;
  queryKey: string;
}

const STORAGE_KEY = "blissops_perf";
const MAX_ENTRIES = 50;

function storePerfEntry(entry: PerfEntry) {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const arr: PerfEntry[] = raw ? JSON.parse(raw) : [];
    arr.push(entry);
    if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // sessionStorage unavailable — ignore silently
  }
}

/**
 * Returns all stored perf entries. Call in browser console:
 *   blissOpsPerf()
 */
if (typeof window !== "undefined" && import.meta.env.DEV) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).blissOpsPerf = () => {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const entries: PerfEntry[] = raw ? JSON.parse(raw) : [];
    console.table(entries.map((e) => ({
      page: e.page,
      duration: `${e.durationMs}ms`,
      items: e.items,
      cache: e.fromCache ? "hit" : "miss",
      ts: new Date(e.ts).toLocaleTimeString(),
    })));
    return entries;
  };
}

export interface PagePerfHandle {
  /** Call once when the primary data has loaded. */
  record: (itemCount: number, fromCache?: boolean) => void;
  /** Reset the timer (e.g. on filter change). */
  reset: () => void;
}

/**
 * Lightweight page performance tracker.
 * @param pageName  Human-readable page label.
 * @param queryKey  Query key string for context.
 */
export function usePagePerf(pageName: string, queryKey = pageName): PagePerfHandle {
  const startRef = useRef(performance.now());
  const recordedRef = useRef(false);

  const record = useCallback(
    (itemCount: number, fromCache = false) => {
      if (recordedRef.current || !import.meta.env.DEV) return;
      recordedRef.current = true;

      const durationMs = Math.round(performance.now() - startRef.current);
      const entry: PerfEntry = {
        page: pageName,
        ts: new Date().toISOString(),
        durationMs,
        items: itemCount,
        fromCache,
        queryKey,
      };

      storePerfEntry(entry);
      console.debug(
        `[perf] ${pageName.padEnd(16)} | ${fromCache ? "cache ✓" : "network"} | ${durationMs}ms | ${itemCount} items`,
      );
    },
    [pageName, queryKey],
  );

  const reset = useCallback(() => {
    startRef.current = performance.now();
    recordedRef.current = false;
  }, []);

  return { record, reset };
}
