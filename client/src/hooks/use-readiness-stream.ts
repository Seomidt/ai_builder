/**
 * Phase 5Z.3 — useReadinessStream hook
 *
 * Subscribes to the server's SSE readiness-stream for a given document and
 * exposes the latest readiness state + auto-trigger logic.
 *
 * Auto-trigger rules (idempotent):
 *  - Only calls onAutoTrigger once per unique triggerKey
 *  - Reconnect / repeated events with the same triggerKey are no-ops
 *  - onAutoTrigger is called when canAutoStartChat=true AND triggerKey changed
 *
 * UX state machine:
 *   idle → connecting → processing → partial_answer_available
 *                                  → improving_answer
 *                                  → complete_answer_available
 *                                  → blocked_partial_answer
 *                                  → failed_document
 *                                  → dead_letter_document
 */

import { useEffect, useRef, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReadinessUxState =
  | "idle"
  | "connecting_to_document_stream"
  | "processing_document"
  | "partial_answer_available"
  | "improving_answer"
  | "complete_answer_available"
  | "blocked_partial_answer"
  | "failed_document"
  | "dead_letter_document";

export interface ReadinessSnapshot {
  documentId:            string;
  documentStatus:        string;
  answerCompleteness:    "none" | "partial" | "complete";
  isPartial:             boolean;
  segmentsReady:         number;
  segmentsTotal:         number;
  coveragePercent:       number;
  retrievalChunksActive: number;
  hasFailedSegments:     boolean;
  hasDeadLetterSegments: boolean;
  fullCompletionBlocked: boolean;
  firstRetrievalReadyAt: string | null;
  timeToFirstRetrievalReadyMs: number | null;
  partialWarning:        string | null;
  canAutoStartChat:      boolean;
  canRefreshForBetterAnswer: boolean;
  triggerKey:            string | null;
  triggerKeyDescription: string | null;
  eligibility:           string;
  pollCount:             number;
  timeSinceConnectMs:    number;
}

export interface UseReadinessStreamOptions {
  documentId:     string | null;
  /** Called when a new triggerKey becomes available and auto-start is appropriate. */
  onAutoTrigger?: (snapshot: ReadinessSnapshot, isImprovement: boolean) => void;
  /** Called when the stream emits any event (for observability). */
  onEvent?:       (eventType: string, snapshot: ReadinessSnapshot) => void;
  /** Set false to disable auto-trigger (e.g. when user is mid-edit). */
  autoTriggerEnabled?: boolean;
}

export interface UseReadinessStreamResult {
  uxState:            ReadinessUxState;
  snapshot:           ReadinessSnapshot | null;
  isConnected:        boolean;
  isStreaming:        boolean;
  lastEventType:      string | null;
  lastTriggerKey:     string | null;
  answerGeneration:   number;
  duplicatesPrevented: number;
  reconnect:          () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS   = 2_000;
const MAX_RECONNECT_ATTEMPTS = 5;

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useReadinessStream(opts: UseReadinessStreamOptions): UseReadinessStreamResult {
  const { documentId, onAutoTrigger, onEvent, autoTriggerEnabled = true } = opts;

  const [uxState,    setUxState]    = useState<ReadinessUxState>("idle");
  const [snapshot,   setSnapshot]   = useState<ReadinessSnapshot | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastEventType, setLastEventType] = useState<string | null>(null);

  // Refs for stable values that shouldn't re-render on change
  const lastTriggerKeyRef     = useRef<string | null>(null);
  const answerGenerationRef   = useRef(0);
  const duplicatesRef         = useRef(0);
  const reconnectAttemptsRef  = useRef(0);
  const eventSourceRef        = useRef<EventSource | null>(null);
  const reconnectTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable callback refs
  const onAutoTriggerRef = useRef(onAutoTrigger);
  const onEventRef       = useRef(onEvent);
  useEffect(() => { onAutoTriggerRef.current = onAutoTrigger; }, [onAutoTrigger]);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  // ── UX state derivation ────────────────────────────────────────────────────
  const deriveUxState = useCallback((
    snap: ReadinessSnapshot,
    eventType: string,
  ): ReadinessUxState => {
    const { documentStatus, answerCompleteness, retrievalChunksActive, fullCompletionBlocked } = snap;

    if (eventType === "dead_letter" || documentStatus === "dead_letter") {
      return "dead_letter_document";
    }
    if (eventType === "failed" || documentStatus === "failed" || documentStatus === "retryable_failed") {
      return "failed_document";
    }
    if (eventType === "completed" || documentStatus === "completed") {
      return "complete_answer_available";
    }
    if (fullCompletionBlocked && retrievalChunksActive === 0) {
      return "blocked_partial_answer";
    }
    if (answerCompleteness === "partial" && retrievalChunksActive > 0) {
      // If this is an improvement after a previous answer, show improving_answer briefly
      if (answerGenerationRef.current > 1) {
        return "improving_answer";
      }
      return "partial_answer_available";
    }
    if (eventType === "status_snapshot" || documentStatus === "processing") {
      return "processing_document";
    }
    return "processing_document";
  }, []);

  // ── Auto-trigger logic ─────────────────────────────────────────────────────
  const handleAutoTrigger = useCallback((
    snap: ReadinessSnapshot,
    eventType: string,
  ) => {
    if (!autoTriggerEnabled) return;
    if (!snap.canAutoStartChat) return;
    if (!snap.triggerKey) return;

    const isNewKey      = snap.triggerKey !== lastTriggerKeyRef.current;
    const isImprovement = lastTriggerKeyRef.current !== null && isNewKey;

    if (!isNewKey) {
      // Same trigger key — duplicate suppression
      duplicatesRef.current++;
      return;
    }

    // New trigger key — proceed with auto-trigger
    lastTriggerKeyRef.current  = snap.triggerKey;
    answerGenerationRef.current++;

    onAutoTriggerRef.current?.(snap, isImprovement);
  }, [autoTriggerEnabled]);

  // ── Connect ────────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!documentId) return;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setUxState("connecting_to_document_stream");
    setIsConnected(false);
    setIsStreaming(true);

    const url = `/api/readiness-stream?documentId=${encodeURIComponent(documentId)}`;
    const es   = new EventSource(url);
    eventSourceRef.current = es;

    const handleEvent = (eventType: string, raw: MessageEvent) => {
      let data: ReadinessSnapshot;
      try {
        data = JSON.parse(raw.data) as ReadinessSnapshot;
      } catch {
        return;
      }

      setSnapshot(data);
      setLastEventType(eventType);
      onEventRef.current?.(eventType, data);

      const newUxState = deriveUxState(data, eventType);
      setUxState(newUxState);

      handleAutoTrigger(data, eventType);
    };

    es.addEventListener("connected",           () => {
      setIsConnected(true);
      reconnectAttemptsRef.current = 0;
      setUxState(snapshot ? deriveUxState(snapshot, "status_snapshot") : "processing_document");
    });

    es.addEventListener("status_snapshot",     (e) => handleEvent("status_snapshot", e));
    es.addEventListener("partial_ready",       (e) => handleEvent("partial_ready", e));
    es.addEventListener("readiness_progress",  (e) => handleEvent("readiness_progress", e));
    es.addEventListener("completed",           (e) => {
      handleEvent("completed", e);
      setIsStreaming(false);
    });
    es.addEventListener("failed",              (e) => {
      handleEvent("failed", e);
      setIsStreaming(false);
    });
    es.addEventListener("dead_letter",         (e) => {
      handleEvent("dead_letter", e);
      setIsStreaming(false);
    });
    es.addEventListener("blocked",             (e) => handleEvent("blocked", e));
    es.addEventListener("keepalive",           () => { /* keep-alive — no state change */ });
    es.addEventListener("error",               (e) => {
      const data = (e as MessageEvent).data;
      if (data) {
        try { handleEvent("error", e as MessageEvent); } catch { /* ignore */ }
      }
      setIsStreaming(false);
    });

    es.onerror = () => {
      setIsConnected(false);
      if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current++;
        reconnectTimerRef.current = setTimeout(() => {
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            connect();
          }
        }, RECONNECT_DELAY_MS * reconnectAttemptsRef.current);
      } else {
        setIsStreaming(false);
      }
    };
  }, [documentId, deriveUxState, handleAutoTrigger, snapshot]);

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!documentId) {
      setUxState("idle");
      return;
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [documentId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Note: `connect` is intentionally not in deps to avoid reconnect loop;
  // documentId change is the only external trigger for reconnect.

  return {
    uxState,
    snapshot,
    isConnected,
    isStreaming,
    lastEventType,
    lastTriggerKey:      lastTriggerKeyRef.current,
    answerGeneration:    answerGenerationRef.current,
    duplicatesPrevented: duplicatesRef.current,
    reconnect:           connect,
  };
}
