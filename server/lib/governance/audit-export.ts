/**
 * Phase 26 — Audit Export System
 * Exports audit, security, moderation, and job history data.
 * Supports date range, tenant scope, and signed export manifests.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import crypto from "crypto";

// ── Export types ───────────────────────────────────────────────────────────────

export type ExportSource = "audit_events" | "security_events" | "moderation_events" | "job_history" | "deletion_jobs" | "legal_holds";

export interface ExportRequest {
  source: ExportSource;
  tenantId?: string;
  startDate?: Date;
  endDate?: Date;
  format?: "json" | "csv" | "ndjson";
  limit?: number;
}

export interface ExportRecord {
  id: string;
  [key: string]: unknown;
}

export interface ExportManifest {
  exportId: string;
  source: ExportSource;
  tenantId?: string;
  startDate?: string;
  endDate?: string;
  format: string;
  recordCount: number;
  generatedAt: string;
  signature: string;   // HMAC-SHA256 of content hash
  contentHash: string; // SHA-256 of records JSON
}

export interface ExportResult {
  manifest: ExportManifest;
  records: ExportRecord[];
  content: string;     // serialised content (JSON/CSV/NDJSON)
}

// ── Table mapping ──────────────────────────────────────────────────────────────

const SOURCE_TABLE_MAP: Record<ExportSource, string | null> = {
  audit_events:      "audit_events",
  security_events:   "security_events",
  moderation_events: "moderation_events",
  job_history:       "background_jobs",
  deletion_jobs:     "data_deletion_jobs",
  legal_holds:       "legal_holds",
};

const SOURCE_DATE_COLUMN: Record<ExportSource, string> = {
  audit_events:      "created_at",
  security_events:   "created_at",
  moderation_events: "created_at",
  job_history:       "created_at",
  deletion_jobs:     "created_at",
  legal_holds:       "created_at",
};

const SOURCE_TENANT_COLUMN: Record<ExportSource, string | null> = {
  audit_events:      "tenant_id",
  security_events:   "tenant_id",
  moderation_events: "tenant_id",
  job_history:       "tenant_id",
  deletion_jobs:     "tenant_id",
  legal_holds:       "tenant_id",
};

// ── Query builder ──────────────────────────────────────────────────────────────

async function queryExportSource(req: ExportRequest): Promise<ExportRecord[]> {
  const table = SOURCE_TABLE_MAP[req.source];
  if (!table) return [];

  const dateCol = SOURCE_DATE_COLUMN[req.source];
  const tenantCol = SOURCE_TENANT_COLUMN[req.source];
  const limit = Math.min(req.limit ?? 10_000, 50_000);

  const conditions: string[] = [];
  if (req.tenantId && tenantCol) {
    conditions.push(`${tenantCol} = '${req.tenantId.replace(/'/g, "''")}'`);
  }
  if (req.startDate) {
    conditions.push(`${dateCol} >= '${req.startDate.toISOString()}'`);
  }
  if (req.endDate) {
    conditions.push(`${dateCol} <= '${req.endDate.toISOString()}'`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM ${table} ${where} ORDER BY ${dateCol} ASC LIMIT ${limit}`;

  try {
    const result = await db.execute(sql.raw(query));
    return result.rows as ExportRecord[];
  } catch {
    return [];
  }
}

// ── Content serializers ────────────────────────────────────────────────────────

function serializeToJson(records: ExportRecord[]): string {
  return JSON.stringify(records, null, 2);
}

function serializeToNdjson(records: ExportRecord[]): string {
  return records.map(r => JSON.stringify(r)).join("\n");
}

function serializeToCsv(records: ExportRecord[]): string {
  if (records.length === 0) return "";
  const keys = Object.keys(records[0]);
  const header = keys.join(",");
  const rows = records.map(r =>
    keys.map(k => {
      const v = r[k];
      if (v === null || v === undefined) return "";
      const str = typeof v === "object" ? JSON.stringify(v) : String(v);
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

// ── Signing ────────────────────────────────────────────────────────────────────

const EXPORT_SIGNING_KEY = process.env.SESSION_SECRET ?? "platform-export-key-default";

function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function signExportManifest(exportId: string, contentHash: string, generatedAt: string): string {
  const payload = `${exportId}|${contentHash}|${generatedAt}`;
  return crypto.createHmac("sha256", EXPORT_SIGNING_KEY).update(payload, "utf8").digest("hex");
}

/**
 * Verify the signature on an export manifest.
 */
export function verifyExportSignature(manifest: ExportManifest): boolean {
  const expected = signExportManifest(manifest.exportId, manifest.contentHash, manifest.generatedAt);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(manifest.signature, "hex"),
    );
  } catch {
    return false;
  }
}

// ── Main export function ───────────────────────────────────────────────────────

/**
 * Export data from the specified source with optional date range + tenant scope.
 * Returns records, serialised content, and a signed manifest.
 */
export async function exportAuditData(req: ExportRequest): Promise<ExportResult> {
  const format = req.format ?? "json";
  const records = await queryExportSource(req);

  let content: string;
  switch (format) {
    case "csv":    content = serializeToCsv(records);    break;
    case "ndjson": content = serializeToNdjson(records); break;
    default:       content = serializeToJson(records);   break;
  }

  const exportId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const contentHash = computeContentHash(content);
  const signature = signExportManifest(exportId, contentHash, generatedAt);

  const manifest: ExportManifest = {
    exportId,
    source: req.source,
    tenantId: req.tenantId,
    startDate: req.startDate?.toISOString(),
    endDate: req.endDate?.toISOString(),
    format,
    recordCount: records.length,
    generatedAt,
    signature,
    contentHash,
  };

  return { manifest, records, content };
}

// ── Bulk export ────────────────────────────────────────────────────────────────

export interface BulkExportResult {
  exports: Array<{ source: ExportSource; manifest: ExportManifest; recordCount: number }>;
  totalRecords: number;
  generatedAt: string;
  tenantId?: string;
}

/**
 * Export all audit sources for a tenant in one operation.
 */
export async function exportAllAuditSources(params: {
  tenantId?: string;
  startDate?: Date;
  endDate?: Date;
  format?: "json" | "csv" | "ndjson";
}): Promise<BulkExportResult> {
  const sources: ExportSource[] = ["audit_events", "security_events", "moderation_events", "deletion_jobs", "legal_holds"];
  const results: BulkExportResult["exports"] = [];
  let totalRecords = 0;

  for (const source of sources) {
    const result = await exportAuditData({ ...params, source });
    results.push({ source, manifest: result.manifest, recordCount: result.records.length });
    totalRecords += result.records.length;
  }

  return { exports: results, totalRecords, generatedAt: new Date().toISOString(), tenantId: params.tenantId };
}

// ── Export manifest validation ─────────────────────────────────────────────────

export interface ManifestValidationResult {
  valid: boolean;
  issues: string[];
  signatureValid: boolean;
}

export function validateExportManifest(manifest: ExportManifest): ManifestValidationResult {
  const issues: string[] = [];

  if (!manifest.exportId) issues.push("Missing exportId");
  if (!manifest.source) issues.push("Missing source");
  if (!manifest.generatedAt) issues.push("Missing generatedAt");
  if (!manifest.contentHash) issues.push("Missing contentHash");
  if (!manifest.signature) issues.push("Missing signature");
  if (typeof manifest.recordCount !== "number") issues.push("Invalid recordCount");

  const signatureValid = issues.length === 0 && verifyExportSignature(manifest);
  if (!signatureValid && issues.length === 0) issues.push("Invalid signature");

  return { valid: issues.length === 0 && signatureValid, issues, signatureValid };
}

// ── Export stats ───────────────────────────────────────────────────────────────

export interface ExportStats {
  availableSources: ExportSource[];
  supportedFormats: string[];
  maxRecordsPerExport: number;
}

export function getExportStats(): ExportStats {
  return {
    availableSources: ["audit_events", "security_events", "moderation_events", "job_history", "deletion_jobs", "legal_holds"],
    supportedFormats: ["json", "csv", "ndjson"],
    maxRecordsPerExport: 50_000,
  };
}
