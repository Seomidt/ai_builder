/**
 * knowledge-documents.ts — Phase 5A
 *
 * Re-exports all document and version lifecycle operations from knowledge-bases.ts.
 * Provides a dedicated import surface for document-centric consumers.
 *
 * This file deliberately keeps document operations co-located with their base
 * operations to enforce the invariant that document creation always validates
 * the parent knowledge base (tenant-safe boundary enforcement).
 */

export {
  createKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  createKnowledgeDocumentVersion,
  getKnowledgeDocumentVersion,
  listKnowledgeDocumentVersions,
  setCurrentDocumentVersion,
  verifyCurrentVersionInvariant,
} from "./knowledge-bases";
