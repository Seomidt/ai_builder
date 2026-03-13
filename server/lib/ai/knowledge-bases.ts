/**
 * knowledge-bases.ts — Phase 5A (hardened)
 *
 * Service helpers for knowledge_bases and knowledge_documents lifecycle.
 *
 * Enforced invariants (service layer):
 *   INV-1  current_version_id may only reference a version owned by the same
 *          document AND tenant. Validated via explicit cross-field check.
 *   INV-2  Exactly one version per document has is_current=true at a time.
 *          Enforced by clearing all before setting. Direct is_current=true on
 *          insert is rejected — callers must use setCurrentDocumentVersion().
 *   INV-3  current_version_id update and is_current flag flip are always
 *          inside a single transaction. Post-tx reads run inside the tx.
 *   INV-4  "ready" document_status requires an explicitly valid current version
 *          AND a retrieval-safe index state ('indexed'). Enforced by
 *          markDocumentReady() — the only permitted path to 'ready'.
 *   INV-5  Cross-tenant linkage rejected: KB, document, and version tenantId
 *          must all match the caller-supplied tenantId at every write path.
 *   INV-6  Version creation and current-version switching are race-safe via
 *          SELECT … FOR UPDATE on the parent document row inside a transaction.
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeIndexState,
  type KnowledgeBase,
  type InsertKnowledgeBase,
  type KnowledgeDocument,
  type InsertKnowledgeDocument,
  type KnowledgeDocumentVersion,
  type InsertKnowledgeDocumentVersion,
} from "@shared/schema";

// ─── Internal error types ──────────────────────────────────────────────────────

export class KnowledgeInvariantError extends Error {
  constructor(invariant: string, detail: string) {
    super(`[knowledge-invariant:${invariant}] ${detail}`);
    this.name = "KnowledgeInvariantError";
  }
}

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

export async function updateKnowledgeBase(
  id: string,
  tenantId: string,
  patch: Partial<Pick<KnowledgeBase, "name" | "description" | "lifecycleState" | "visibility" | "defaultRetrievalK" | "updatedBy">>,
): Promise<KnowledgeBase | undefined> {
  const [row] = await db
    .update(knowledgeBases)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(knowledgeBases.id, id), eq(knowledgeBases.tenantId, tenantId)))
    .returning();
  return row;
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

/**
 * createKnowledgeDocument
 *
 * INV-5: Validates that the parent knowledge base belongs to input.tenantId.
 *        Rejects if base.tenantId !== input.tenantId (explicit cross-field check,
 *        not just a query filter).
 */
export async function createKnowledgeDocument(
  input: InsertKnowledgeDocument,
): Promise<KnowledgeDocument> {
  const base = await getKnowledgeBase(input.knowledgeBaseId, input.tenantId);
  if (!base) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `knowledge_base ${input.knowledgeBaseId} not found for tenant ${input.tenantId}`,
    );
  }
  if (base.tenantId !== input.tenantId) {
    throw new KnowledgeInvariantError(
      "INV-5",
      `cross-tenant linkage rejected: knowledge_base ${base.id} belongs to tenant ${base.tenantId}, caller is tenant ${input.tenantId}`,
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

export async function softDeleteDocument(
  id: string,
  tenantId: string,
): Promise<KnowledgeDocument | undefined> {
  const [row] = await db
    .update(knowledgeDocuments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(knowledgeDocuments.id, id), eq(knowledgeDocuments.tenantId, tenantId)))
    .returning();
  return row;
}

// ─── Document Version Operations ──────────────────────────────────────────────

/**
 * createKnowledgeDocumentVersion
 *
 * INV-2: Rejects input with isCurrent=true. Callers must use
 *        setCurrentDocumentVersion() to switch the current version.
 *        Allowing direct is_current=true on insert bypasses the single-
 *        current-version guarantee enforced by the transaction in
 *        setCurrentDocumentVersion.
 *
 * INV-5: Verifies document belongs to input.tenantId with an explicit
 *        tenantId field check (not just a query filter).
 *
 * INV-6: Acquires a FOR UPDATE row lock on the parent document inside a
 *        transaction before computing the next version number. This prevents
 *        two concurrent calls from both reading latestVersionNumber=N and
 *        both inserting version N+1.
 */
export async function createKnowledgeDocumentVersion(
  input: InsertKnowledgeDocumentVersion,
): Promise<KnowledgeDocumentVersion> {
  if ((input as any).isCurrent === true) {
    throw new KnowledgeInvariantError(
      "INV-2",
      "isCurrent=true is not permitted on version insert. Use setCurrentDocumentVersion() after creation.",
    );
  }

  return db.transaction(async (tx) => {
    const lockedRows = await tx.execute(
      sql`SELECT id, tenant_id, latest_version_number FROM knowledge_documents WHERE id = ${input.knowledgeDocumentId} FOR UPDATE`,
    );
    const lockedDoc = lockedRows.rows[0] as {
      id: string;
      tenant_id: string;
      latest_version_number: number;
    } | undefined;

    if (!lockedDoc) {
      throw new KnowledgeInvariantError(
        "INV-5",
        `knowledge_document ${input.knowledgeDocumentId} not found`,
      );
    }
    if (lockedDoc.tenant_id !== input.tenantId) {
      throw new KnowledgeInvariantError(
        "INV-5",
        `cross-tenant linkage rejected: document ${lockedDoc.id} belongs to tenant ${lockedDoc.tenant_id}, caller is tenant ${input.tenantId}`,
      );
    }

    const nextVersion = lockedDoc.latest_version_number + 1;
    const versionNumber = input.versionNumber ?? nextVersion;

    if (versionNumber <= lockedDoc.latest_version_number) {
      throw new KnowledgeInvariantError(
        "INV-6",
        `version_number ${versionNumber} is not greater than current latest ${lockedDoc.latest_version_number} — race or duplicate detected`,
      );
    }

    const [row] = await tx
      .insert(knowledgeDocumentVersions)
      .values({ ...input, versionNumber, isCurrent: false })
      .returning();

    await tx
      .update(knowledgeDocuments)
      .set({ latestVersionNumber: versionNumber, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, lockedDoc.id));

    return row;
  });
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
 * setCurrentDocumentVersion — Core multi-invariant enforcer.
 *
 * INV-1: Validates that the requested version belongs to the same
 *        document AND tenant via explicit field comparison — not just
 *        query filters.
 *
 * INV-2: Clears is_current on all other versions before setting the new
 *        one, ensuring exactly one current version at all times.
 *
 * INV-3: All mutations (clear old, set new is_current, update document
 *        current_version_id, post-tx reads) execute inside a single
 *        transaction. The updated rows are read inside the tx to avoid
 *        stale-read races.
 *
 * INV-6: Acquires a FOR UPDATE lock on the document row at the start of
 *        the transaction to prevent concurrent switches from producing
 *        two rows with is_current=true.
 *
 * This is the ONLY safe path to change current_version_id.
 */
export async function setCurrentDocumentVersion(
  documentId: string,
  versionId: string,
  tenantId: string,
): Promise<{ document: KnowledgeDocument; version: KnowledgeDocumentVersion }> {
  return db.transaction(async (tx) => {
    const lockedRows = await tx.execute(
      sql`SELECT id, tenant_id FROM knowledge_documents WHERE id = ${documentId} FOR UPDATE`,
    );
    const lockedDoc = lockedRows.rows[0] as { id: string; tenant_id: string } | undefined;

    if (!lockedDoc) {
      throw new KnowledgeInvariantError(
        "INV-1",
        `document ${documentId} not found`,
      );
    }
    if (lockedDoc.tenant_id !== tenantId) {
      throw new KnowledgeInvariantError(
        "INV-5",
        `cross-tenant linkage rejected: document ${documentId} belongs to tenant ${lockedDoc.tenant_id}, caller is tenant ${tenantId}`,
      );
    }

    const versionRows = await tx.execute(
      sql`SELECT id, tenant_id, knowledge_document_id FROM knowledge_document_versions WHERE id = ${versionId}`,
    );
    const versionRow = versionRows.rows[0] as {
      id: string;
      tenant_id: string;
      knowledge_document_id: string;
    } | undefined;

    if (!versionRow) {
      throw new KnowledgeInvariantError(
        "INV-1",
        `version ${versionId} not found`,
      );
    }
    if (versionRow.tenant_id !== tenantId) {
      throw new KnowledgeInvariantError(
        "INV-1",
        `cross-tenant linkage rejected: version ${versionId} belongs to tenant ${versionRow.tenant_id}, caller is tenant ${tenantId}`,
      );
    }
    if (versionRow.knowledge_document_id !== documentId) {
      throw new KnowledgeInvariantError(
        "INV-1",
        `version ${versionId} belongs to document ${versionRow.knowledge_document_id}, not ${documentId} — linkage rejected`,
      );
    }

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

    const updatedDocRows = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId));
    const updatedVersionRows = await tx
      .select()
      .from(knowledgeDocumentVersions)
      .where(eq(knowledgeDocumentVersions.id, versionId));

    return {
      document: updatedDocRows[0],
      version: updatedVersionRows[0],
    };
  });
}

/**
 * markDocumentReady — INV-4 enforcer.
 *
 * Sets document_status = 'ready' only when ALL of the following hold:
 *   1. document.current_version_id is not null
 *   2. The referenced version belongs to this document and tenant (INV-1)
 *   3. knowledge_index_state for that version has index_state = 'indexed'
 *
 * A document must never become 'ready' merely because a version exists.
 * Ready means the content is retrievable end-to-end.
 *
 * Returns a structured result — the update is skipped on any violation.
 */
export async function markDocumentReady(
  documentId: string,
  tenantId: string,
): Promise<{
  updated: boolean;
  document: KnowledgeDocument | null;
  blockers: string[];
}> {
  const blockers: string[] = [];

  const doc = await getKnowledgeDocument(documentId, tenantId);
  if (!doc) {
    return { updated: false, document: null, blockers: [`document ${documentId} not found for tenant ${tenantId}`] };
  }

  if (!doc.currentVersionId) {
    blockers.push("document has no current_version_id — call setCurrentDocumentVersion() first");
  }

  let indexedVersion: KnowledgeDocumentVersion | undefined;

  if (doc.currentVersionId) {
    const version = await getKnowledgeDocumentVersion(doc.currentVersionId, tenantId);
    if (!version) {
      blockers.push(`current_version_id ${doc.currentVersionId} not found for tenant ${tenantId} — dangling reference`);
    } else if (version.knowledgeDocumentId !== documentId) {
      blockers.push(
        `INV-1 violation: current_version_id ${doc.currentVersionId} belongs to document ${version.knowledgeDocumentId}, not ${documentId}`,
      );
    } else {
      indexedVersion = version;

      const [indexRow] = await db
        .select()
        .from(knowledgeIndexState)
        .where(
          and(
            eq(knowledgeIndexState.knowledgeDocumentVersionId, doc.currentVersionId),
            eq(knowledgeIndexState.tenantId, tenantId),
          ),
        );

      if (!indexRow) {
        blockers.push(`no index_state row for version ${doc.currentVersionId} — indexing has not been recorded`);
      } else if (indexRow.indexState !== "indexed") {
        blockers.push(`index_state is '${indexRow.indexState}', must be 'indexed' for ready transition`);
      }
    }
  }

  if (blockers.length > 0) {
    return { updated: false, document: doc, blockers };
  }

  const [updated] = await db
    .update(knowledgeDocuments)
    .set({ documentStatus: "ready", updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.tenantId, tenantId),
      ),
    )
    .returning();

  return { updated: true, document: updated, blockers: [] };
}

/**
 * verifyCurrentVersionInvariant — diagnostic safety check.
 *
 * Checks INV-1 and INV-2 for a document without mutating anything.
 * Returns a structured report of any violations found.
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
      issues: [`document ${documentId} not found for tenant ${tenantId}`],
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
    issues.push(
      `INV-1: document.current_version_id is null but ${currentVersionRows} version(s) have is_current=true`,
    );
  }
  if (doc.currentVersionId !== null && currentVersionRows === 0) {
    issues.push(
      `INV-1: document.current_version_id is set but no version has is_current=true`,
    );
  }
  if (currentVersionRows > 1) {
    issues.push(
      `INV-2: ${currentVersionRows} versions have is_current=true — exactly one is required`,
    );
  }

  if (doc.currentVersionId !== null) {
    const version = await getKnowledgeDocumentVersion(doc.currentVersionId, tenantId);
    if (!version) {
      issues.push(
        `INV-1: current_version_id ${doc.currentVersionId} not found for tenant ${tenantId} — dangling reference`,
      );
    } else if (version.knowledgeDocumentId !== documentId) {
      issues.push(
        `INV-1: current_version_id ${doc.currentVersionId} belongs to document ${version.knowledgeDocumentId}, not ${documentId}`,
      );
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    documentCurrentVersionId: doc.currentVersionId ?? null,
    currentVersionRows,
  };
}
