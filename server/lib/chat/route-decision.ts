/**
 * route-decision.ts — Core routing logic for automatic chat context selection.
 *
 * Implements the 5-rule routing priority model:
 *
 *  RULE A: completed valid attachment + no relevant expert
 *          → attachment_first
 *
 *  RULE B: completed valid attachment + relevant expert(s) found
 *          → hybrid  (attachment = primary, expert = secondary)
 *
 *  RULE C: no usable attachment + expert(s) found
 *          → expert_auto
 *
 *  RULE D: attachment present in request but not ready / processing
 *          → processing (gated — no AI call)
 *
 *  RULE E: no attachment + no relevant expert
 *          → no_context  (controlled, no hallucination)
 *
 * Multi-tenant safety: all DB queries require tenantId.
 * Logging: every decision is written to chat_route_decisions asynchronously.
 */

import type { AccessibleExpert }            from "../../services/chat-routing.ts";
import { autoSelectExperts, verifyPreferredExpert, type ExpertMatch } from "./expert-router.ts";
import { detectConversationAttachmentState, type ResolvedAttachment, type AttachmentStatus } from "./attachment-state.ts";
import { logRouteDecision }                                            from "./route-logging.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export type RouteType =
  | "attachment_first"   // RULE A
  | "hybrid"             // RULE B
  | "expert_auto"        // RULE C
  | "processing"         // RULE D – attachment uploading/OCR in progress
  | "not_ready"          // RULE D variant – attachment failed or dead_letter
  | "no_context";        // RULE E

/** A single document context item (same shape as chat-runner expects). */
export interface DocumentContextItem {
  filename:       string;
  mime_type:      string;
  char_count:     number;
  extracted_text: string;
  status:         "ok" | "unsupported" | "error";
  message?:       string;
}

export interface RouteDecision {
  routeType:           RouteType;
  /** Document context to inject into the AI prompt (may come from request or DB store). */
  documentContext:     DocumentContextItem[];
  /** Primary expert to use for expert_auto or hybrid routing. */
  primaryExpert:       AccessibleExpert | null;
  /** All selected experts (for hybrid: up to 3). */
  selectedExperts:     ExpertMatch[];
  /** Human-readable explanation for debugging / logging. */
  routingExplanation:  string;
  /** Whether the route requires an AI call (false = gated response). */
  requiresAiCall:      boolean;
  /** User-facing status message (shown in frontend instead of AI response when gated). */
  gatingMessage?:      string;
  /** Attachment IDs used (from DB store). */
  attachmentIds:       string[];
}

// ── Request attachment helpers ─────────────────────────────────────────────────

/** Extract only valid (status=ok, non-empty text) items from the request payload. */
function getValidRequestAttachments(documentContext: DocumentContextItem[]): DocumentContextItem[] {
  return documentContext.filter(
    // Minimum 5 chars — accepts short text/plain files; 50 was too aggressive for direct reads.
    (d) => d.status === "ok" && (d.extracted_text?.trim().length ?? 0) >= 5,
  );
}

/** True if the request has attachment items that are NOT valid (processing/failed). */
function hasInvalidRequestAttachments(documentContext: DocumentContextItem[]): boolean {
  return documentContext.some(
    (d) => d.status === "error" || (d.status === "ok" && !d.extracted_text?.trim()),
  );
}

/** Convert DB-stored attachments to DocumentContextItem format. */
function attachmentsToDocCtx(attachments: ResolvedAttachment[]): DocumentContextItem[] {
  return attachments.map((a) => ({
    filename:       a.filename,
    mime_type:      a.mimeType,
    char_count:     a.charCount,
    extracted_text: a.extractedText,
    status:         "ok" as const,
  }));
}

// ── Main resolve function ─────────────────────────────────────────────────────

export async function resolveRouteDecision(params: {
  message:            string;
  organizationId:     string;
  userId:             string;
  conversationId?:    string | null;
  /** Raw document_context from the current request (may be empty for follow-up messages). */
  documentContext:    DocumentContextItem[];
  /** Optional preferred expert hint from client (always re-verified). */
  preferredExpertId?: string | null;
}): Promise<RouteDecision> {
  const {
    message,
    organizationId,
    userId,
    conversationId,
    documentContext,
    preferredExpertId,
  } = params;

  // ── Step 1: Assess current-request attachment quality ─────────────────────
  const validRequestDocs   = getValidRequestAttachments(documentContext);
  const hasInvalidDocs     = hasInvalidRequestAttachments(documentContext);
  const hasRequestDocs     = validRequestDocs.length > 0;

  // ── Step 2: Check DB for prior conversation attachments ──────────────────
  let storedAttachmentState: { status: AttachmentStatus; attachments: ResolvedAttachment[] } = {
    status: "none",
    attachments: [],
  };
  if (conversationId && !hasRequestDocs) {
    storedAttachmentState = await detectConversationAttachmentState(conversationId, organizationId);
  }

  const hasStoredAttachment = storedAttachmentState.status === "completed_valid";
  const effectiveDocs: DocumentContextItem[] = hasRequestDocs
    ? validRequestDocs
    : hasStoredAttachment
      ? attachmentsToDocCtx(storedAttachmentState.attachments)
      : [];

  const hasAnyAttachment = effectiveDocs.length > 0;

  // ── Step 3: RULE D — Processing gate (invalid attachment in request) ──────
  // Only applies when request explicitly contained attachments that aren't ready.
  if (!hasRequestDocs && hasInvalidDocs) {
    const decision: RouteDecision = {
      routeType:          "processing",
      documentContext:    [],
      primaryExpert:      null,
      selectedExperts:    [],
      routingExplanation: "Dokumentet behandles — svar er forebygget for at undgå hallucinering.",
      requiresAiCall:     false,
      gatingMessage:      "Dokumentet behandles stadig. Prøv igen om lidt.",
      attachmentIds:      [],
    };
    void logDecision(decision, params);
    return decision;
  }

  // ── Step 4: Expert routing (runs regardless of attachment status) ─────────
  let expertResult = await (
    preferredExpertId
      ? verifyPreferredExpert({ expertId: preferredExpertId, organizationId, message })
          .then((m) => m
            ? { experts: [m], hasRelevantMatch: m.isRelevant, primary: m }
            : autoSelectExperts({ message, organizationId })
          )
      : autoSelectExperts({ message, organizationId })
  );

  // ── Step 5: Apply routing rules ───────────────────────────────────────────

  // RULE A / RULE B: valid attachment present
  if (hasAnyAttachment) {
    const storedIds = hasStoredAttachment
      ? storedAttachmentState.attachments.map((a) => a.id)
      : [];

    if (expertResult.hasRelevantMatch && expertResult.primary) {
      // RULE B — Hybrid (attachment = primary, expert = secondary)
      const decision: RouteDecision = {
        routeType:          "hybrid",
        documentContext:    effectiveDocs,
        primaryExpert:      expertResult.primary.expert,
        selectedExperts:    expertResult.experts,
        routingExplanation: `Hybrid: Uploadet dokument (primær) + ${expertResult.primary.expert.name} (sekundær).`,
        requiresAiCall:     true,
        attachmentIds:      storedIds,
      };
      void logDecision(decision, params);
      return decision;
    }

    // RULE A — Attachment-first (no relevant expert OR no experts at all)
    const decision: RouteDecision = {
      routeType:          "attachment_first",
      documentContext:    effectiveDocs,
      primaryExpert:      expertResult.primary?.expert ?? null,
      selectedExperts:    expertResult.experts,
      routingExplanation: `Attachment-first: Svar baseret udelukkende på uploadet dokument.`,
      requiresAiCall:     true,
      attachmentIds:      storedIds,
    };
    void logDecision(decision, params);
    return decision;
  }

  // RULE C — Expert auto (no attachment, expert(s) found)
  if (expertResult.primary) {
    const decision: RouteDecision = {
      routeType:          "expert_auto",
      documentContext:    [],
      primaryExpert:      expertResult.primary.expert,
      selectedExperts:    expertResult.experts,
      routingExplanation: expertResult.primary.explanation,
      requiresAiCall:     true,
      attachmentIds:      [],
    };
    void logDecision(decision, params);
    return decision;
  }

  // RULE E — No context at all
  const decision: RouteDecision = {
    routeType:          "no_context",
    documentContext:    [],
    primaryExpert:      null,
    selectedExperts:    [],
    routingExplanation: "Ingen uploadet dokument og ingen tilgængelig ekspert fundet.",
    requiresAiCall:     false,
    gatingMessage:      "Jeg har ingen tilgængelig viden at svare ud fra. Upload venligst et dokument eller kontakt support.",
    attachmentIds:      [],
  };
  void logDecision(decision, params);
  return decision;
}

// ── Internal: fire-and-forget route logging ───────────────────────────────────

async function logDecision(
  decision: RouteDecision,
  params: {
    message: string;
    organizationId: string;
    userId: string;
    conversationId?: string | null;
  },
): Promise<void> {
  try {
    await logRouteDecision({
      tenantId:       params.organizationId,
      conversationId: params.conversationId ?? undefined,
      userId:         params.userId,
      routeType:      decision.routeType,
      attachmentIds:  decision.attachmentIds,
      expertIds:      decision.selectedExperts.map((e) => e.expert.id),
      routeReason:    decision.routingExplanation,
      expertScore:    decision.selectedExperts[0]?.score ?? null,
      hasAttachment:  decision.documentContext.length > 0,
      hasExperts:     decision.selectedExperts.length > 0,
    });
  } catch (err) {
    console.error("[route-decision] Failed to log decision:", (err as Error).message);
  }
}
