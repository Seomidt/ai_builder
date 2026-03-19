/**
 * Phase 50 — Analytics Foundation
 * React hook for client-side event tracking
 *
 * Provides a stable memoized track function.
 * Debounces high-frequency events (e.g. page views on fast navigation).
 * Attaches locale and session metadata automatically.
 */

import { useCallback, useRef } from "react";
import {
  track,
  type ClientTrackPayload,
} from "@/lib/analytics/track";

export function useTrackEvent() {
  return useCallback(
    (payload: ClientTrackPayload) => {
      track(payload).catch(() => {});
    },
    [],
  );
}

// ─── Debounced variant for high-frequency events ──────────────────────────────

export function useTrackEventDebounced(debounceMs = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (payload: ClientTrackPayload) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        track(payload).catch(() => {});
      }, debounceMs);
    },
    [debounceMs],
  );
}

// ─── Page/route tracking helper ───────────────────────────────────────────────

export function usePageTrack() {
  const trackEvent = useTrackEvent();

  return useCallback(
    (eventName: ClientTrackPayload["eventName"], route: string) => {
      trackEvent({
        eventName,
        properties: { route },
      });
    },
    [trackEvent],
  );
}
