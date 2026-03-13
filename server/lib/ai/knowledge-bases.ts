/**
 * knowledge-bases.ts — Phase 5A
 *
 * Service helpers for knowledge_bases and knowledge_documents lifecycle management.
 *
 * Design invariants enforced here:
 *   - All operations validate tenant_id ownership across linked rows
 *   - knowledge_documents.current_version_id must reference a version where is_current=true
 *     from the same document (enforced by setCurrentDocumentVersion)
 *   - Exactly one version per document has is_current=true at a time
 *   - Document status transitions are explicit — never inferred from version existence
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  type KnowledgeBase,
  type InsertKnowledgeBase,
  type KnowledgeDocument,
  type InsertKnowledgeDocument,
  type KnowledgeDocumentVersion,
  type InsertKnowledgeDocumentVersion,
} from "@shared/schema";

// ─── Knowledge Base Operations ────────────────────────────────────────────────

export async function createKnowledgeBase(
  input: InsertKnowledgeBase,
): Promise<KnowledgeBase> {
  const [row] = await db.insert(knowledgeBases).values(input).returning();
  return row;
}

export async function getKnowledgeBase(
  id: string,
  tenantId: string,
): Promise<KnowledgeBase | undefined> {
  const [row] = await db
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, id), eq(knowledgeBases.tenantId, tenantId)));
  return row;
}

export async function listKnowledgeBases(
  tenantId: string,
  lifecycleState?: string,
): Promise<KnowledgeBase[]> {
  const conditions = [eq(knowledgeBases.tenantId, tenantId)];
  if (lifecycleState) {
    conditions.push(eq(knowledgeBases.lifecycleState, lifecycleState));
  }
  return db
    .select()
    .from(knowledgeBases)
    .where(and(...conditions))
    .orderBy(desc(knowledgeBases.createdAt));
}

export async function archiveKnowledgeBase(
  id: string,
  tenantId: string,
  updatedBy?: string,
): Promise<KnowledgeBase | undefined> {
  const [row] = await db
    .update(knowledgeBases)
    .set({ lifecycleState: "archived", updatedBy: updatedBy ?? null, updatedAt: new Date() })
    .where(and(eq(knowledgeBases.id, id), eq(knowledgeBases.tenantId, tenantId)))
    .returning();
  return row;
}

// ─── Knowledge Document Operations ───────────────────────────────────────────

export async function createKnowledgeDocument(
  input: InsertKnowledgeDocument,
): Promise<KnowledgeDocument> {
  const base = await getKnowledgeBase(input.knowledgeBaseId, input.tenantId);
  if (!base) {
    throw new Error(
      `[knowledge-bases] knowledge_base ${input.knowledgeBaseId} not found for tenant ${input.tenantId}`,
    );
  }
  const [row] = await db.insert(knowledgeDocuments).values(input).returning();
  return row;
}

export async function getKnowledgeDocument(
  id: string,
  tenantId: string,
): Promise<KnowledgeDocument | undefined> {
  const [row] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.tenantId, tenantId)));
  return row;
}

export async function listKnowledgeDocuments(
  tenantId: string,
  knowledgeBaseId?: string,
  documentStatus?: string,
): Promise<KnowledgeDocument[]> {
  const conditions = [eq(knowledgeDocuments.tenantId, tenantId)];
  if (knowledgeBaseId) conditions.push(eq(knowledgeDocuments.knowledgeBaseId, knowledgeBaseId));
  if (documentStatus) conditions.push(eq(knowledgeDocuments.documentStatus, documentStatus));
  return db
    .select()
    .from(knowledgeDocuments)
    .where(and(...conditions))
    .orderBy(desc(knowledgeDocuments.createdAt));
}

// ─── Document Version Operations ─────────────────────────────────────────────

export async function createKnowledgeDocumentVersion(
  input: InsertKnowledgeDocumentVersion,
): Promise<KnowledgeDocumentVersion> {
  const doc = await getKnowledgeDocument(input.knowledgeDocumentId, input.tenantId);
  if (!doc) {
    throw new Error(
      `[knowledge-bases] knowledge_document ${input.knowledgeDocumentId} not found for tenant ${input.tenantId}`,
    );
  }
  const [row] = await db.insert(knowledgeDocumentVersions).values(input).returning();
  await db
    .update(knowledgeDocuments)
    .set({
      latestVersionNumber: Math.max(doc.latestVersionNumber, input.versionNumber),
      updatedAt: new Date(),
    })
    .where(eq(knowledgeDocuments.id, doc.id));
  return row;
}

export async function getKnowledgeDocumentVersion(
  id: string,
  tenantId: string,
): Promise<KnowledgeDocumentVersion | undefined> {
  const [row] = await db
    .select()
    .from(knowledgeDocumentVersions)
    .where(
      and(
        eq(knowledgeDocumentVersions.id, id),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    );
  return row;
}

export async function listKnowledgeDocumentVersions(
  documentId: string,
  tenantId: string,
): Promise<KnowledgeDocumentVersion[]> {
  return db
    .select()
    .from(knowledgeDocumentVersions)
    .where(
      and(
        eq(knowledgeDocumentVersions.knowledgeDocumentId, documentId),
        eq(knowledgeDocumentVersions.tenantId, tenantId),
      ),
    )
    .orderBy(desc(knowledgeDocumentVersions.versionNumber));
}

/**
 * setCurrentDocumentVersion — Core invariant enforcer.
 *
 * Atomically:
 *   1. Validates version belongs to this document + tenant
 *   2. Clears is_current on any previously current version
 *   3. Sets is_current = true on the target version
 *   4. Updates document.current_version_id to the target version id
 *
 * This is the ONLY safe way to change the current version.
 * Never update current_version_id directly without calling this function.
 */
export async function setCurrentDocumentVersion(
  documentId: string,
  versionId: string,
  tenantId: string,
): Promise<{ document: KnowledgeDocument; version: KnowledgeDocumentVersion }> {
  const version = await getKnowledgeDocumentVersion(versionId, tenantId);
  if (!version) {
    throw new Error(
      `[knowledge-bases] version ${versionId} not found for tenant ${tenantId}`,
    );
  }
  if (version.knowledgeDocumentId !== documentId) {
    throw new Error(
      `[knowledge-bases] INVARIANT VIOLATION: version ${versionId} belongs to document ${version.knowledgeDocumentId}, not ${documentId}`,
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(knowledgeDocumentVersions)
      .set({ isCurrent: false })
      .where(
        and(
          eq(knowledgeDocumentVersions.knowledgeDocumentId, documentId),
          eq(knowledgeDocumentVersions.isCurrent, true),
        ),
      );

    await tx
      .update(knowledgeDocumentVersions)
      .set({ isCurrent: true })
      .where(eq(knowledgeDocumentVersions.id, versionId));

    await tx
      .update(knowledgeDocuments)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, documentId));
  });

  const [updatedDoc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, documentId));
  const [updatedVersion] = await db
    .select()
    .from(knowledgeDocumentVersions)
    .where(eq(knowledgeDocumentVersions.id, versionId));

  return { document: updatedDoc, version: updatedVersion };
}

/**
 * Verify current-version invariant for a document.
 * Returns a structured safety check result — never throws.
 */
export async function verifyCurrentVersionInvariant(
  documentId: string,
  tenantId: string,
): Promise<{
  valid: boolean;
  issues: string[];
  documentCurrentVersionId: string | null;
  currentVersionRows: number;
}> {
  const doc = await getKnowledgeDocument(documentId, tenantId);
  if (!doc) {
    return {
      valid: false,
      issues: [`Document ${documentId} not found for tenant ${tenantId}`],
      documentCurrentVersionId: null,
      currentVersionRows: 0,
    };
  }

  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(knowledgeDocumentVersions)
    .where(
      and(
        eq(knowledgeDocumentVersions.knowledgeDocumentId, documentId),
        eq(knowledgeDocumentVersions.isCurrent, true),
      ),
    );
  const currentVersionRows = Number(countRow?.count ?? 0);
  const issues: string[] = [];

  if (doc.currentVersionId === null && currentVersionRows > 0) {
    issues.push(`document.current_version_id is null but ${currentVersionRows} version(s) have is_current=true`);
  }
  if (doc.currentVersionId !== null && currentVersionRows === 0) {
    issues.push(`document.current_version_id is set but no version has is_current=true`);
  }
  if (currentVersionRows > 1) {
    issues.push(`${currentVersionRows} versions have is_current=true — only one is allowed`);
  }

  return {
    valid: issues.length === 0,
    issues,
    documentCurrentVersionId: doc.currentVersionId ?? null,
    currentVersionRows,
  };
}
