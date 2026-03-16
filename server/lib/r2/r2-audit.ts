/**
 * R2 Audit Logger — Task 3
 * Logs all storage actions as structured events.
 *
 * Events:
 *   r2_upload_requested, r2_upload_completed, r2_signed_upload_url_created,
 *   r2_signed_download_url_created, r2_download_started, r2_object_deleted,
 *   r2_access_denied, r2_multipart_started, r2_multipart_completed,
 *   r2_multipart_aborted
 *
 * Security rules:
 *   - NEVER log full signed URLs
 *   - NEVER log secret keys / credentials
 *   - Log only safe metadata: actor, tenantId, key prefix, size, result, timestamp
 */

export type R2AuditEvent =
  | "r2_upload_requested"
  | "r2_upload_completed"
  | "r2_signed_upload_url_created"
  | "r2_signed_download_url_created"
  | "r2_download_started"
  | "r2_object_deleted"
  | "r2_access_denied"
  | "r2_multipart_started"
  | "r2_multipart_part_url_created"
  | "r2_multipart_completed"
  | "r2_multipart_aborted"
  | "r2_usage_queried"
  | "r2_list_objects";

export interface R2AuditPayload {
  event:      R2AuditEvent;
  actorId?:   string;
  tenantId?:  string;
  keyPrefix?: string;     // normalized / truncated — never full signed URL
  sizeBytes?: number;
  result?:    "success" | "denied" | "error";
  reason?:    string;
  ts:         string;
}

function redactSignedUrl(url?: string): string | undefined {
  if (!url) return undefined;
  // Return only the path part, strip query (which contains the signature)
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "[redacted-url]";
  }
}

export function logR2Event(payload: Omit<R2AuditPayload, "ts">): void {
  const entry: R2AuditPayload = { ...payload, ts: new Date().toISOString() };

  // Structured JSON line — picked up by any log aggregator
  console.log(JSON.stringify({ source: "r2-audit", ...entry }));
}

/** Convenience wrappers */

export function auditUploadRequested(opts: { actorId?: string; tenantId?: string; keyPrefix: string }): void {
  logR2Event({ event: "r2_upload_requested", result: "success", ...opts });
}

export function auditUploadCompleted(opts: { actorId?: string; tenantId?: string; keyPrefix: string; sizeBytes?: number }): void {
  logR2Event({ event: "r2_upload_completed", result: "success", ...opts });
}

export function auditSignedUploadUrl(opts: { actorId?: string; tenantId?: string; keyPrefix: string }): void {
  logR2Event({ event: "r2_signed_upload_url_created", result: "success", ...opts });
}

export function auditSignedDownloadUrl(opts: { actorId?: string; tenantId?: string; keyPrefix: string }): void {
  logR2Event({ event: "r2_signed_download_url_created", result: "success", ...opts });
}

export function auditDownloadStarted(opts: { actorId?: string; tenantId?: string; keyPrefix: string }): void {
  logR2Event({ event: "r2_download_started", result: "success", ...opts });
}

export function auditObjectDeleted(opts: { actorId?: string; tenantId?: string; keyPrefix: string }): void {
  logR2Event({ event: "r2_object_deleted", result: "success", ...opts });
}

export function auditAccessDenied(opts: { actorId?: string; tenantId?: string; keyPrefix?: string; reason: string }): void {
  logR2Event({ event: "r2_access_denied", result: "denied", ...opts });
}

export function auditMultipartStarted(opts: { actorId?: string; tenantId?: string; keyPrefix: string }): void {
  logR2Event({ event: "r2_multipart_started", result: "success", ...opts });
}

export function auditMultipartCompleted(opts: { actorId?: string; tenantId?: string; keyPrefix: string; sizeBytes?: number }): void {
  logR2Event({ event: "r2_multipart_completed", result: "success", ...opts });
}

export function auditMultipartAborted(opts: { actorId?: string; tenantId?: string; keyPrefix: string }): void {
  logR2Event({ event: "r2_multipart_aborted", result: "success", ...opts });
}
