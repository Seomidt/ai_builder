/**
 * useQueryState — stable filter/sort state with URL-sync upgrade path.
 *
 * Currently wraps useState. Upgrade path: sync to URLSearchParams so filters
 * survive back-navigation and can be bookmarked (no API changes needed).
 *
 * Live data boundary: filter changes trigger a new server-side RPC call
 * (the queryKey includes the filter value, so the cache is properly segmented).
 */

import { useState } from "react";

/**
 * @param _key  URL param name (reserved for future URL-sync upgrade)
 * @param defaultValue  Initial value
 */
export function useQueryState(
  _key: string,
  defaultValue: string,
): [string, (value: string) => void] {
  return useState<string>(defaultValue);
}
