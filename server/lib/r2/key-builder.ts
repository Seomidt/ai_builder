/**
 * R2 Key Builder — Task 1
 * Enforces tenant-scoped and platform-level storage path conventions.
 *
 * Key strategy:
 *   tenants/{tenantId}/{category}/{normalizedFilename}
 *   platform/{category}/{normalizedFilename}
 *
 * Categories: uploads | invoices | exports | logs | backups | audit-exports
 */

export const TENANT_ROOT    = "tenants";
export const PLATFORM_ROOT  = "platform";

export type TenantCategory   = "uploads" | "invoices" | "exports" | "logs" | "reports" | "attachments";
export type PlatformCategory = "backups" | "audit-exports" | "snapshots" | "migrations";

// ── Filename normalisation ──────────────────────────────────────────────────

/**
 * Strips dangerous path traversal characters and collapses whitespace.
 * Replaces anything other than alphanumeric, dash, underscore, dot with "-".
 */
export function normalizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename; // strip any path prefix
  return base
    .replace(/\.\./g, "")                  // no parent-dir traversal
    .replace(/[^a-zA-Z0-9._\-]/g, "-")    // safe chars only
    .replace(/-{2,}/g, "-")               // collapse multiple dashes
    .replace(/^[-.]/, "")                 // no leading dash/dot
    .slice(0, 255) || "unnamed";          // max length guard
}

// ── Key builders ────────────────────────────────────────────────────────────

export function buildTenantObjectKey(
  tenantId:  string,
  category:  TenantCategory,
  filename:  string,
): string {
  if (!tenantId || tenantId.trim() === "") throw new Error("tenantId is required");
  const safeName = normalizeFilename(filename);
  return `${TENANT_ROOT}/${tenantId}/${category}/${safeName}`;
}

export function buildPlatformObjectKey(
  category:  PlatformCategory,
  filename:  string,
): string {
  const safeName = normalizeFilename(filename);
  return `${PLATFORM_ROOT}/${category}/${safeName}`;
}

// ── Ownership assertions ────────────────────────────────────────────────────

/**
 * Verifies that a key actually belongs to the given tenant.
 * Throws if it doesn't — prevents cross-tenant access via crafted keys.
 */
export function assertTenantScopedKey(key: string, tenantId: string): void {
  const expected = `${TENANT_ROOT}/${tenantId}/`;
  if (!key.startsWith(expected)) {
    throw new Error(
      `Key "${key}" is not scoped to tenant "${tenantId}". ` +
      `Expected prefix: "${expected}"`,
    );
  }
}

export function isPlatformKey(key: string): boolean {
  return key.startsWith(`${PLATFORM_ROOT}/`);
}

export function isTenantKey(key: string, tenantId?: string): boolean {
  if (tenantId) return key.startsWith(`${TENANT_ROOT}/${tenantId}/`);
  return key.startsWith(`${TENANT_ROOT}/`);
}

/** Extract tenantId from a tenant-scoped key (or null for platform keys) */
export function extractTenantId(key: string): string | null {
  const parts = key.split("/");
  if (parts[0] === TENANT_ROOT && parts.length >= 3) return parts[1];
  return null;
}

/** Sanitize the key for safe logging (redact if it looks suspicious) */
export function safeKeyForLog(key: string): string {
  return key.replace(/[<>'"]/g, "").slice(0, 512);
}
