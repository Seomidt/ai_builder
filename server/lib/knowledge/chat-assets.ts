/**
 * Chat Asset Service — Phase 1 + Phase 4 + Phase 6 (tenant retention)
 *
 * Manages the lifecycle of chat-uploaded files as knowledge_documents:
 *   temporary_chat  → asset created on chat upload, not yet in KB
 *   persistent_storage → asset promoted by user to a KB
 *
 * INV: All operations are tenant-scoped. No cross-tenant access.
 * INV: promoteAssetToStorage only changes scope; it never duplicates blobs or rows.
 * INV: asset_scope and retention are independent concerns.
 *      A temporary_chat asset may still be physically stored for 30/90/forever.
 */

import pg from "pg";
import { logAuditBestEffort } from "../audit/audit-log.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssetScope = "temporary_chat" | "persistent_storage";
export type AssetOrigin = "chat_upload" | "storage_upload" | "imported";
export type RetentionMode = "session" | "days" | "forever";

/** Tenant-level retention choices exposed in the admin UI */
export type TenantRetentionMode = "days_30" | "days_90" | "forever";

export interface TenantRetentionSettings {
  tenantId: string;
  defaultRetentionMode: TenantRetentionMode;
}

/**
 * Translates a TenantRetentionMode into the concrete retention_mode + days
 * values used when writing a knowledge_document row.
 */
export function resolveRetentionFromTenantMode(mode: TenantRetentionMode): {
  retentionMode: RetentionMode;
  retentionDays: number | undefined;
} {
  switch (mode) {
    case "days_30":  return { retentionMode: "days", retentionDays: 30 };
    case "days_90":  return { retentionMode: "days", retentionDays: 90 };
    case "forever":  return { retentionMode: "forever", retentionDays: undefined };
  }
}

// ─── getTenantRetentionSettings ───────────────────────────────────────────────

/**
 * Reads the tenant's default retention setting from tenant_storage_settings.
 * Returns { defaultRetentionMode: "days_30" } if no row exists (safe default).
 */
export async function getTenantRetentionSettings(
  tenantId: string,
): Promise<TenantRetentionSettings> {
  const client = getClient();
  try {
    await client.connect();
    const result = await client.query<Record<string, unknown>>(
      `SELECT tenant_id, default_retention_mode
         FROM tenant_storage_settings
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenantId],
    );
    if (result.rowCount && result.rowCount > 0) {
      return {
        tenantId,
        defaultRetentionMode: (result.rows[0]["default_retention_mode"] as TenantRetentionMode) ?? "days_30",
      };
    }
    return { tenantId, defaultRetentionMode: "days_30" };
  } finally {
    await client.end();
  }
}

// ─── upsertTenantRetentionSettings ────────────────────────────────────────────

/**
 * Creates or updates the tenant's default retention mode.
 * Validates mode is one of days_30 | days_90 | forever before writing.
 */
export async function upsertTenantRetentionSettings(
  tenantId: string,
  defaultRetentionMode: TenantRetentionMode,
): Promise<TenantRetentionSettings> {
  const valid: TenantRetentionMode[] = ["days_30", "days_90", "forever"];
  if (!valid.includes(defaultRetentionMode)) {
    throw Object.assign(
      new Error(`Invalid defaultRetentionMode: ${defaultRetentionMode}`),
      { code: "INVALID_RETENTION_MODE" },
    );
  }

  const client = getClient();
  try {
    await client.connect();
    await client.query(
      `INSERT INTO tenant_storage_settings (tenant_id, default_retention_mode, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE
         SET default_retention_mode = EXCLUDED.default_retention_mode,
             updated_at             = NOW()`,
      [tenantId, defaultRetentionMode],
    );
    return { tenantId, defaultRetentionMode };
  } finally {
    await client.end();
  }
}

export interface ChatAsset {
  id: string;
  tenantId: string;
  knowledgeBaseId: string | null;
  title: string;
  documentType: string;
  documentStatus: string;
  assetScope: AssetScope;
  assetOrigin: AssetOrigin;
  chatThreadId: string | null;
  fileHash: string | null;
  /** Phase 5: r2Key parsed from metadata jsonb — null if not yet uploaded to R2 */
  r2Key: string | null;
  isPinned: boolean;
  promotedToStorageAt: Date | null;
  retentionMode: RetentionMode | null;
  retentionExpiresAt: Date | null;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** NEXT-A: persisted transcript/OCR text — null if not yet extracted */
  extractedText: string | null;
  /** NEXT-A: 'ready' | 'failed' | null (null = not yet processed) */
  extractedTextStatus: "ready" | "failed" | null;
  /** NEXT-A: ISO timestamp of last extraction — null if not yet processed */
  extractedAt: string | null;
}

function rowToAsset(r: Record<string, unknown>): ChatAsset {
  // metadata is jsonb — pg driver returns it as a parsed JS object
  const meta = r["metadata"] as Record<string, unknown> | null;
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    knowledgeBaseId: (r["knowledge_base_id"] as string) ?? null,
    title: r["title"] as string,
    documentType: r["document_type"] as string,
    documentStatus: r["document_status"] as string,
    assetScope: (r["asset_scope"] as AssetScope) ?? "persistent_storage",
    assetOrigin: (r["asset_origin"] as AssetOrigin) ?? "storage_upload",
    chatThreadId: (r["chat_thread_id"] as string) ?? null,
    fileHash: (r["file_hash"] as string) ?? null,
    r2Key: (meta?.["r2Key"] as string) ?? null,
    isPinned: (r["is_pinned"] as boolean) ?? false,
    promotedToStorageAt: r["promoted_to_storage_at"]
      ? new Date(r["promoted_to_storage_at"] as string)
      : null,
    retentionMode: (r["retention_mode"] as RetentionMode) ?? null,
    retentionExpiresAt: r["retention_expires_at"]
      ? new Date(r["retention_expires_at"] as string)
      : null,
    lastAccessedAt: r["last_accessed_at"]
      ? new Date(r["last_accessed_at"] as string)
      : null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
    // NEXT-A: transcript fields from metadata jsonb
    extractedText:       (meta?.["extractedText"] as string)       ?? null,
    extractedTextStatus: (meta?.["extractedTextStatus"] as "ready" | "failed") ?? null,
    extractedAt:         (meta?.["extractedAt"] as string)         ?? null,
  };
}

// ─── createChatAsset ──────────────────────────────────────────────────────────

/**
 * Creates a knowledge_document with scope=temporary_chat for a chat upload.
 * knowledgeBaseId is intentionally null — it will be set on promotion.
 */
export async function createChatAsset(params: {
  tenantId: string;
  title: string;
  documentType?: string;
  fileHash?: string;
  mimeType?: string;
  sizeBytes?: number;
  chatThreadId?: string;
  r2Key?: string;
  retentionMode?: RetentionMode;
  retentionDays?: number;
  actorId?: string;
}): Promise<ChatAsset> {
  const {
    tenantId,
    title,
    documentType = "other",
    fileHash,
    mimeType,
    sizeBytes,
    chatThreadId,
    r2Key,
    retentionMode = "session",
    retentionDays,
    actorId,
  } = params;

  const retentionExpiresAt =
    retentionMode === "days" && retentionDays
      ? new Date(Date.now() + retentionDays * 86_400_000)
      : null;

  const client = getClient();
  try {
    await client.connect();

    const result = await client.query<Record<string, unknown>>(
      `INSERT INTO knowledge_documents (
        tenant_id,
        knowledge_base_id,
        title,
        document_type,
        source_type,
        lifecycle_state,
        document_status,
        asset_scope,
        asset_origin,
        chat_thread_id,
        file_hash,
        retention_mode,
        retention_expires_at,
        metadata,
        created_by,
        updated_by,
        created_at,
        updated_at
      ) VALUES (
        $1, NULL, $2, $3, 'upload', 'active', 'draft',
        'temporary_chat', 'chat_upload',
        $4, $5, $6, $7,
        $8::jsonb,
        $9, $9,
        NOW(), NOW()
      )
      RETURNING *`,
      [
        tenantId,
        title,
        documentType,
        chatThreadId ?? null,
        fileHash ?? null,
        retentionMode,
        retentionExpiresAt,
        JSON.stringify({
          mimeType: mimeType ?? null,
          sizeBytes: sizeBytes ?? null,
          r2Key: r2Key ?? null,
        }),
        actorId ?? null,
      ],
    );

    const asset = rowToAsset(result.rows[0]);

    await logAuditBestEffort({
      tenantId,
      actorId: actorId ?? "system",
      action: "chat_asset.created",
      resourceType: "knowledge_document",
      resourceId: asset.id,
      metadata: { scope: "temporary_chat", chatThreadId },
    });

    return asset;
  } finally {
    await client.end();
  }
}

// ─── promoteAssetToStorage ────────────────────────────────────────────────────

/**
 * Promotes a temporary_chat asset to persistent_storage.
 * The SAME row is updated — no new asset, no duplicate blob, no double billing.
 *
 * INV: asset must belong to tenantId.
 * INV: asset must currently be scope=temporary_chat.
 */
export async function promoteAssetToStorage(params: {
  assetId: string;
  tenantId: string;
  targetKbId: string;
  retentionMode?: RetentionMode;
  retentionDays?: number;
  isPinned?: boolean;
  actorId?: string;
}): Promise<ChatAsset> {
  const {
    assetId,
    tenantId,
    targetKbId,
    retentionMode = "days",
    retentionDays = 365,
    isPinned = false,
    actorId,
  } = params;

  const retentionExpiresAt =
    retentionMode === "days"
      ? new Date(Date.now() + retentionDays * 86_400_000)
      : null;

  const client = getClient();
  try {
    await client.connect();

    // Verify ownership + current scope
    const check = await client.query<Record<string, unknown>>(
      `SELECT id, asset_scope FROM knowledge_documents
       WHERE id = $1 AND tenant_id = $2 AND lifecycle_state = 'active'
       LIMIT 1`,
      [assetId, tenantId],
    );

    if (check.rowCount === 0) {
      throw Object.assign(
        new Error(`Asset ${assetId} not found for tenant ${tenantId}`),
        { code: "ASSET_NOT_FOUND" },
      );
    }

    const currentScope = check.rows[0]["asset_scope"] as string;
    if (currentScope !== "temporary_chat") {
      throw Object.assign(
        new Error(`Asset ${assetId} is already ${currentScope}`),
        { code: "ALREADY_PROMOTED" },
      );
    }

    // Update the SAME row — scope change only
    const result = await client.query<Record<string, unknown>>(
      `UPDATE knowledge_documents SET
        knowledge_base_id    = $3,
        asset_scope          = 'persistent_storage',
        promoted_to_storage_at = NOW(),
        retention_mode       = $4,
        retention_expires_at = $5,
        is_pinned            = $6,
        updated_by           = $7,
        updated_at           = NOW()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
      [
        assetId,
        tenantId,
        targetKbId,
        retentionMode,
        retentionMode === "forever" ? null : retentionExpiresAt,
        isPinned,
        actorId ?? null,
      ],
    );

    const asset = rowToAsset(result.rows[0]);

    await logAuditBestEffort({
      tenantId,
      actorId: actorId ?? "system",
      action: "chat_asset.promoted",
      resourceType: "knowledge_document",
      resourceId: asset.id,
      metadata: {
        targetKbId,
        retentionMode,
        isPinned,
        promotedToStorageAt: asset.promotedToStorageAt,
      },
    });

    return asset;
  } finally {
    await client.end();
  }
}

// ─── findAssetByFileHash ──────────────────────────────────────────────────────

/**
 * Tenant-scoped file hash lookup for deduplication.
 * Returns the first active asset with matching hash, or null.
 * INV: Cross-tenant reuse is forbidden — always scoped to tenantId.
 */
export async function findAssetByFileHash(params: {
  tenantId: string;
  fileHash: string;
}): Promise<ChatAsset | null> {
  const { tenantId, fileHash } = params;

  const client = getClient();
  try {
    await client.connect();

    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM knowledge_documents
       WHERE tenant_id = $1
         AND file_hash = $2
         AND lifecycle_state = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, fileHash],
    );

    return result.rowCount && result.rowCount > 0
      ? rowToAsset(result.rows[0])
      : null;
  } finally {
    await client.end();
  }
}

// ─── getAssetById ─────────────────────────────────────────────────────────────

export async function getAssetById(params: {
  assetId: string;
  tenantId: string;
}): Promise<ChatAsset | null> {
  const { assetId, tenantId } = params;

  const client = getClient();
  try {
    await client.connect();

    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM knowledge_documents
       WHERE id = $1 AND tenant_id = $2 AND lifecycle_state = 'active'
       LIMIT 1`,
      [assetId, tenantId],
    );

    return result.rowCount && result.rowCount > 0
      ? rowToAsset(result.rows[0])
      : null;
  } finally {
    await client.end();
  }
}

// ─── listChatAssets ───────────────────────────────────────────────────────────

/**
 * Lists temporary_chat assets for a given thread, ordered newest first.
 */
export async function listChatAssets(params: {
  tenantId: string;
  chatThreadId?: string;
  scope?: AssetScope;
  limit?: number;
  offset?: number;
}): Promise<ChatAsset[]> {
  const {
    tenantId,
    chatThreadId,
    scope,
    limit = 50,
    offset = 0,
  } = params;

  const conditions: string[] = [
    "tenant_id = $1",
    "lifecycle_state = 'active'",
  ];
  const values: unknown[] = [tenantId];
  let idx = 2;

  if (chatThreadId) {
    conditions.push(`chat_thread_id = $${idx++}`);
    values.push(chatThreadId);
  }
  if (scope) {
    conditions.push(`asset_scope = $${idx++}`);
    values.push(scope);
  }

  values.push(limit, offset);

  const client = getClient();
  try {
    await client.connect();

    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM knowledge_documents
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      values,
    );

    return result.rows.map(rowToAsset);
  } finally {
    await client.end();
  }
}

// ─── patchAssetR2Key ──────────────────────────────────────────────────────────

/**
 * Updates an asset with the R2 object key after background upload completes.
 * Also persists mime_type / size_bytes into the metadata JSON field.
 * Idempotent: safe to call multiple times with the same r2Key.
 */
export async function patchAssetR2Key(params: {
  assetId: string;
  tenantId: string;
  r2Key: string;
  mimeType?: string;
  sizeBytes?: number;
  documentStatus?: "draft" | "processing" | "ready" | "failed";
}): Promise<ChatAsset> {
  const { assetId, tenantId, r2Key, mimeType, sizeBytes, documentStatus = "processing" } = params;

  const client = getClient();
  try {
    await client.connect();

    const result = await client.query<Record<string, unknown>>(
      `UPDATE knowledge_documents
         SET metadata     = COALESCE(metadata, '{}'::jsonb)
                           || jsonb_build_object(
                                'r2Key',      $3,
                                'mimeType',   $4::text,
                                'sizeBytes',  $5::bigint
                              ),
             document_status = $6,
             updated_at      = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [assetId, tenantId, r2Key, mimeType ?? null, sizeBytes ?? null, documentStatus],
    );

    if (!result.rowCount) {
      throw Object.assign(
        new Error(`Asset ${assetId} not found for tenant ${tenantId}`),
        { code: "ASSET_NOT_FOUND" },
      );
    }

    return rowToAsset(result.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── patchAssetTranscript ─────────────────────────────────────────────────────

/**
 * Persists extracted text (transcript/OCR) into knowledge_documents.metadata.
 * Shared persistence model for ALL file types:
 *   - TXT/CSV/MD → extractionSource = "direct"
 *   - PDF (native) → extractionSource = "r2_pdf_parse"
 *   - PDF (OCR)    → extractionSource = "r2_ocr_async" | "ocr_partial"
 *   - Images       → extractionSource = "gemini_vision"
 *   - Audio        → extractionSource = "gemini_audio"
 *   - Video        → extractionSource = "gemini_video"
 *
 * Fields written into metadata jsonb (merged via ||):
 *   extractedText        — full transcript or extracted text (capped at 80 000 chars)
 *   extractedTextStatus  — 'ready' | 'failed'
 *   extractedAt          — ISO timestamp of extraction
 *   charCount            — total character count
 *   extractionSource     — pipeline engine identifier
 *
 * Sets document_status='ready' so HASH_HIT queries know reusable text exists.
 * Idempotent: safe to call multiple times — JSONB merge overwrites keys.
 */
export async function patchAssetTranscript(params: {
  assetId:   string;
  tenantId:  string;
  extractedText:       string;
  extractedTextStatus: "ready" | "failed";
  charCount?:          number;
  extractionSource?:   string;
}): Promise<void> {
  const { assetId, tenantId, extractedText, extractedTextStatus, charCount, extractionSource } = params;

  const client = getClient();
  try {
    await client.connect();
    await client.query(
      `UPDATE knowledge_documents
         SET metadata       = COALESCE(metadata, '{}'::jsonb)
                             || jsonb_build_object(
                                  'extractedText',       $3::text,
                                  'extractedTextStatus', $4::text,
                                  'extractedAt',         NOW()::text,
                                  'charCount',           $5::int,
                                  'extractionSource',    $6::text
                                ),
             document_status = CASE
               WHEN $4 = 'ready' THEN 'ready'
               ELSE document_status
             END,
             updated_at     = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [
        assetId,
        tenantId,
        extractedText,
        extractedTextStatus,
        charCount ?? extractedText.length,
        extractionSource ?? "unknown",
      ],
    );
  } finally {
    await client.end();
  }
}

// ─── touchAsset ───────────────────────────────────────────────────────────────

/** Updates last_accessed_at — call whenever an asset is used in a chat answer. */
export async function touchAsset(params: {
  assetId: string;
  tenantId: string;
}): Promise<void> {
  const { assetId, tenantId } = params;

  const client = getClient();
  try {
    await client.connect();
    await client.query(
      `UPDATE knowledge_documents
       SET last_accessed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [assetId, tenantId],
    );
  } finally {
    await client.end();
  }
}
