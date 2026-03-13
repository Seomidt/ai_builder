/**
 * knowledge-documents.ts — Phase 5A (hardened)
 *
 * Dedicated import surface for document and version lifecycle operations.
 * All invariant enforcement lives in knowledge-bases.ts.
 *
 * Re-exported invariant contracts:
 *   INV-1  current_version_id must reference a version from the same document + tenant
 *   INV-2  Exactly one version per document has is_current=true at a time
 *   INV-3  current_version_id and is_current updates are always in one transaction
 *   INV-4  markDocumentReady() is the only path to document_status='ready'
 *   INV-5  Cross-tenant linkage rejected at every write path
 *   INV-6  Version creation and current-version switching are race-safe (FOR UPDATE)
 */

export {
  KnowledgeInvariantError,
  createKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
  archiveKnowledgeBase,
  createKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  softDeleteDocument,
  createKnowledgeDocumentVersion,
  getKnowledgeDocumentVersion,
  listKnowledgeDocumentVersions,
  setCurrentDocumentVersion,
  markDocumentReady,
  verifyCurrentVersionInvariant,
} from "./knowledge-bases";
