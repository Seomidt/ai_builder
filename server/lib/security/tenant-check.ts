/**
 * Phase 13.1 — Tenant Ownership Enforcement
 * Provides assertTenantResource() for route-level tenant isolation checks.
 * Must be called on any resource fetched from DB before returning it to a requester.
 *
 * Error hierarchy:
 *   ForbiddenError  (403) — resource exists but does not belong to caller's tenant
 *   NotFoundError   (404) — resource was not found (use storage to check existence)
 *
 * Usage:
 *   const run = await storage.getRun(id);
 *   if (!run) return res.status(404).json({ error: "Not found" });
 *   assertTenantResource(run.tenantId, req.user!.organizationId);
 *   res.json(run);
 */

// ── Custom error classes ───────────────────────────────────────────────────────

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  readonly errorCode = "FORBIDDEN";

  constructor(message = "Access denied: resource belongs to a different tenant") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  readonly errorCode = "UNAUTHORIZED";

  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly errorCode = "NOT_FOUND";

  constructor(resource = "Resource") {
    super(`${resource} not found`);
    this.name = "NotFoundError";
  }
}

// ── assertTenantResource ──────────────────────────────────────────────────────

/**
 * Assert that the resource's tenant matches the requesting actor's tenant.
 *
 * Throws ForbiddenError (403) if:
 *   - resourceTenantId !== requestTenantId
 *   - Either argument is null/undefined/empty string
 *
 * This is the canonical cross-tenant access control check.
 * Apply to all routes involving tenant-scoped resources:
 *   runs, artifacts, artifact_dependencies, run_steps, exports
 *
 * @param resourceTenantId  tenant_id from the fetched DB resource
 * @param requestTenantId   tenant from the authenticated request (req.user.organizationId)
 */
export function assertTenantResource(
  resourceTenantId: string | null | undefined,
  requestTenantId: string | null | undefined,
): void {
  if (
    !resourceTenantId ||
    !requestTenantId ||
    resourceTenantId !== requestTenantId
  ) {
    throw new ForbiddenError(
      `Access denied: resource belongs to tenant '${resourceTenantId ?? "(none)"}', ` +
        `request from tenant '${requestTenantId ?? "(none)"}'`,
    );
  }
}

// ── requireOwnerRole ──────────────────────────────────────────────────────────

/**
 * Require that the request's user has the 'owner' role.
 * Throws ForbiddenError if the role is anything other than 'owner'.
 * Used for config endpoints and sensitive admin operations.
 */
export function requireOwnerRole(role: string | undefined): void {
  if (role !== "owner") {
    throw new ForbiddenError("This endpoint requires the 'owner' role");
  }
}

// ── assertNotDemo ─────────────────────────────────────────────────────────────

/**
 * Assert the current request is NOT from a demo user.
 * Throws UnauthorizedError for write operations that must not be executed by demo users.
 */
export function assertNotDemo(userId: string | undefined): void {
  if (!userId || userId.startsWith("demo-")) {
    throw new UnauthorizedError("Demo users cannot perform this operation");
  }
}
