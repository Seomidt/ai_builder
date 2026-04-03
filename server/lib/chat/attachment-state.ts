/**
 * attachment-state.ts — Conversation-level attachment state detection.
 *
 * Queries the DB to determine if a conversation has a usable processed
 * attachment. Used by route-decision.ts to implement RULE A/D.
 *
 * Two paths feed into this:
 *  1. Sync path: inline document_context sent in the current request
 *  2. Stored path: attachment saved from a previous turn in the conversation
 */

import { db } from "../../db.ts";
import { chatConversationAttachments } from "../../../shared/schema.ts";
import { and, eq, desc }               from "drizzle-orm";

export type AttachmentStatus =
  | "completed_valid"   // usable extracted text available
  | "none";             // no attachment in this conversation

export interface ResolvedAttachment {
  id:            string;
  filename:      string;
  mimeType:      string;
  extractedText: string;
  charCount:     number;
}

export interface ConversationAttachmentState {
  status:      AttachmentStatus;
  attachments: ResolvedAttachment[];
}

/**
 * Detect the most recent completed attachment(s) for a conversation.
 * Returns at most 3 most recent completed attachments (newest first).
 * Tenant isolation enforced — always requires tenantId.
 */
export async function detectConversationAttachmentState(
  conversationId: string,
  tenantId:       string,
): Promise<ConversationAttachmentState> {
  if (!conversationId) {
    return { status: "none", attachments: [] };
  }

  const rows = await db
    .select()
    .from(chatConversationAttachments)
    .where(
      and(
        eq(chatConversationAttachments.conversationId, conversationId),
        eq(chatConversationAttachments.tenantId, tenantId),
        eq(chatConversationAttachments.status, "completed"),
      ),
    )
    .orderBy(desc(chatConversationAttachments.createdAt))
    .limit(3);

  if (rows.length === 0) {
    return { status: "none", attachments: [] };
  }

  const valid = rows.filter((r) => r.extractedText.trim().length >= 50);
  if (valid.length === 0) {
    return { status: "none", attachments: [] };
  }

  return {
    status: "completed_valid",
    attachments: valid.map((r) => ({
      id:            r.id,
      filename:      r.filename,
      mimeType:      r.mimeType,
      extractedText: r.extractedText,
      charCount:     r.charCount,
    })),
  };
}

/**
 * Save a processed attachment to the conversation store.
 * Called when a chat message arrives with valid document_context.
 * Idempotent: duplicate filenames in the same conversation are allowed
 * (user may re-upload a revised version).
 */
export async function saveConversationAttachment(params: {
  conversationId: string;
  tenantId:       string;
  filename:       string;
  mimeType:       string;
  extractedText:  string;
  charCount:      number;
}): Promise<string> {
  const [row] = await db
    .insert(chatConversationAttachments)
    .values({
      conversationId: params.conversationId,
      tenantId:       params.tenantId,
      filename:       params.filename,
      mimeType:       params.mimeType,
      extractedText:  params.extractedText,
      charCount:      params.charCount,
      status:         "completed",
    })
    .returning({ id: chatConversationAttachments.id });

  return row.id;
}
