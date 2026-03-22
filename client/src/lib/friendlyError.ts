/**
 * friendlyError — maps ApiError codes and HTTP statuses to clean UI messages.
 *
 * Rules:
 *  - Never expose raw provider error text (e.g. "401 You didn't provide an API key...")
 *  - Never show stack traces or internal messages
 *  - Return a short, actionable sentence the user can understand
 *
 * Usage:
 *   onError: (err) => toast({ title: "Error", description: friendlyError(err) })
 *   setErrorMsg(friendlyError(err))
 */

import { ApiError } from "./queryClient";

const CODE_MESSAGES: Record<string, string> = {
  SESSION_REQUIRED:              "Your session has expired. Please log in again.",
  INVALID_SESSION:               "Your session is invalid. Please log in again.",
  INVALID_AUTH_HEADER:           "Authentication failed. Please log in again.",
  EMPTY_BEARER_TOKEN:            "Authentication token is missing. Please log in again.",
  UNAUTHORIZED:                  "Authentication required. Please log in.",
  PLATFORM_ADMIN_REQUIRED:       "This action requires platform admin access.",
  TENANT_ACCESS_DENIED:          "You don't have access to this resource.",
  FORBIDDEN:                     "Access denied.",
  NOT_FOUND:                     "The requested resource was not found.",
  CONFLICT:                      "A conflict occurred — this resource may already exist.",
  DUPLICATE_SLUG:                "This slug is already in use. Choose a different slug.",
  VALIDATION_ERROR:              "Please check your input and try again.",
  TENANT_CONTEXT_MISSING:        "Tenant context is missing. Please reload the page.",
  TENANT_MEMBERSHIP_NOT_FOUND:   "Your membership in this tenant could not be verified.",
  PROVIDER_NOT_CONFIGURED:       "This feature requires an AI provider that is not yet configured. Contact your platform admin.",
  FEATURE_NOT_AVAILABLE:         "This feature is not yet available in your plan.",
  INTERNAL_ERROR:                "An internal error occurred. Please try again.",
  UNKNOWN_ERROR:                 "An unexpected error occurred. Please try again.",
};

const STATUS_MESSAGES: Record<number, string> = {
  401: "Authentication required. Please log in.",
  403: "Access denied.",
  404: "The requested resource was not found.",
  409: "A conflict occurred — this resource may already exist.",
  422: "Request could not be processed. Please check your input.",
  429: "Too many requests. Please wait a moment and try again.",
  500: "An internal server error occurred. Please try again.",
  502: "The server is temporarily unavailable. Please try again.",
  503: "Service is temporarily unavailable. Please try again.",
};

/**
 * Returns a safe, user-friendly error message for display in the UI.
 * Accepts ApiError (from apiRequest/useQuery), raw Error, or unknown.
 */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    // Prefer code-mapped message over raw server message
    if (err.errorCode && CODE_MESSAGES[err.errorCode]) {
      return CODE_MESSAGES[err.errorCode];
    }
    // For 4xx (except 500), the server message is already clean (from our typed errors)
    if (err.status >= 400 && err.status < 500 && err.message) {
      return err.message;
    }
    // Fall back to status-based message
    if (STATUS_MESSAGES[err.status]) {
      return STATUS_MESSAGES[err.status];
    }
    // Last resort — safe generic
    return "An unexpected error occurred. Please try again.";
  }

  if (err instanceof Error) {
    // Generic Error — never show raw message (could be raw SDK error)
    return "An unexpected error occurred. Please try again.";
  }

  return "An unexpected error occurred. Please try again.";
}
