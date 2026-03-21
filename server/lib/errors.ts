/**
 * Typed AppError hierarchy.
 *
 * Every expected failure MUST throw one of these instead of a generic Error
 * so that handleError can map it to the correct HTTP status + error_code.
 *
 * Mapping:
 *   UnauthorizedError  → 401  (SESSION_REQUIRED | INVALID_AUTH_HEADER | EMPTY_BEARER_TOKEN | INVALID_SESSION)
 *   ForbiddenError     → 403  (PLATFORM_ADMIN_REQUIRED | TENANT_ACCESS_DENIED)
 *   NotFoundError      → 404  (NOT_FOUND)
 *   ConflictError      → 409  (CONFLICT | DUPLICATE_SLUG)
 *   ValidationError    → 422  (VALIDATION_ERROR | TENANT_CONTEXT_MISSING | TENANT_MEMBERSHIP_NOT_FOUND)
 *   AppError (generic) → any status
 *
 * True bugs that nobody anticipated → let handleError fall through to 500 INTERNAL_ERROR.
 */

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ── 401 Unauthorized ─────────────────────────────────────────────────────────

export class UnauthorizedError extends AppError {
  constructor(
    errorCode:
      | "SESSION_REQUIRED"
      | "INVALID_AUTH_HEADER"
      | "EMPTY_BEARER_TOKEN"
      | "INVALID_SESSION"
      | "UNAUTHORIZED" = "UNAUTHORIZED",
    message = "Authentication required.",
  ) {
    super(401, errorCode, message);
    this.name = "UnauthorizedError";
  }
}

// ── 403 Forbidden ─────────────────────────────────────────────────────────────

export class ForbiddenError extends AppError {
  constructor(
    errorCode: "PLATFORM_ADMIN_REQUIRED" | "TENANT_ACCESS_DENIED" | "FORBIDDEN" = "FORBIDDEN",
    message = "Access denied.",
  ) {
    super(403, errorCode, message);
    this.name = "ForbiddenError";
  }
}

// ── 404 Not Found ─────────────────────────────────────────────────────────────

export class NotFoundError extends AppError {
  constructor(message = "Resource not found.") {
    super(404, "NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

// ── 409 Conflict ──────────────────────────────────────────────────────────────

export class ConflictError extends AppError {
  constructor(
    errorCode: "CONFLICT" | "DUPLICATE_SLUG" = "CONFLICT",
    message = "A conflict occurred — a resource with this identifier may already exist.",
  ) {
    super(409, errorCode, message);
    this.name = "ConflictError";
  }
}

// ── 422 Unprocessable ─────────────────────────────────────────────────────────

export class ValidationError extends AppError {
  constructor(
    errorCode:
      | "VALIDATION_ERROR"
      | "TENANT_CONTEXT_MISSING"
      | "TENANT_MEMBERSHIP_NOT_FOUND" = "VALIDATION_ERROR",
    message = "Validation failed.",
  ) {
    super(422, errorCode, message);
    this.name = "ValidationError";
  }
}

// ── Supabase / Postgres error mapping ────────────────────────────────────────
// Call this from assertNoError / anywhere a Supabase error object is received.
// Returns a typed AppError or null (caller should then throw its own Error).

export interface SupabaseErrorShape {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export function mapSupabaseError(error: SupabaseErrorShape, context: string): AppError | null {
  const { message, code } = error;

  // Postgres unique constraint violation → 409
  if (code === "23505" || message?.includes("duplicate key value")) {
    const isSlug = message?.includes("slug");
    return new ConflictError(
      isSlug ? "DUPLICATE_SLUG" : "CONFLICT",
      isSlug
        ? "This slug is already in use. Choose a different slug."
        : "A resource with this identifier already exists.",
    );
  }

  // Postgres FK violation → 422
  if (code === "23503") {
    return new ValidationError(
      "TENANT_CONTEXT_MISSING",
      "Invalid reference: the specified organization or related resource does not exist.",
    );
  }

  // Postgres permission denied → 403
  if (code === "42501" || message?.includes("permission denied")) {
    return new ForbiddenError("TENANT_ACCESS_DENIED", "You do not have permission to access this resource.");
  }

  // Supabase Auth / JWT errors → 401
  if (
    message?.includes("JWT") ||
    message?.includes("token is expired") ||
    message?.includes("invalid token") ||
    message?.includes("not authenticated")
  ) {
    return new UnauthorizedError("INVALID_SESSION", "Invalid or expired session. Please sign in again.");
  }

  // Row not found (Supabase PGRST116) → 404
  if (code === "PGRST116" || message?.includes("no rows")) {
    return new NotFoundError(`${context}: resource not found.`);
  }

  return null;
}
