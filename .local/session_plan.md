# Objective
PHASE NEXT-A/B — Transcript Persistence + Retention Cleanup Engine

# Tasks

### T001: Transcript persistence on knowledge_documents.metadata (NEXT-A)
- **Blocked By**: []
- **Details**:
  - patchAssetTranscript() in chat-assets.ts — writes extractedText + extractedTextStatus + extractedAt to metadata jsonb + document_status='ready'
  - Finalize route: accept optional assetId in body; call patchAssetTranscript() after audio/video ok
  - GET /api/knowledge/assets/by-hash: include extractedText + extractedTextStatus from metadata in response
  - Files: server/lib/knowledge/chat-assets.ts, server/routes.ts

### T002: HASH_HIT transcript reuse on client (NEXT-A cont.)
- **Blocked By**: [T001]
- **Details**:
  - Pass assetId in finalize body from _slowAssetRef
  - On HASH_HIT audio/video: if asset has extractedText → inject into finalizeResults directly, skip finalize call
  - AssetRef: add extractedText field
  - Files: client/src/pages/ai-chat.tsx

### T003: Retention cleanup engine (NEXT-B)
- **Blocked By**: []
- **Details**:
  - server/lib/knowledge/retention-cleanup.ts: runRetentionCleanupBatch()
  - FOR UPDATE SKIP LOCKED batching, tenant-safe, idempotent
  - R2 delete via DeleteObjectCommand
  - Soft-delete: lifecycle_state='archived', deleted_at=NOW(), metadata.retentionPurgedAt
  - Audit log per deleted asset
  - POST /api/admin/retention/cleanup manual trigger
  - setInterval in server/index.ts (every 6h)
  - Files: server/lib/knowledge/retention-cleanup.ts, server/routes.ts, server/index.ts
