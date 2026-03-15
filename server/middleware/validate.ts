/**
 * Phase 13.1 — Central Request Validation Middleware
 * Provides Zod-based schema validation for body, params, and query.
 * Attaches validated values to req.validated for downstream route handlers.
 * On failure: returns 400 with structured error, never calls next().
 */

import type { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";

// ── Extend Express Request with validated namespace ───────────────────────────

declare global {
  namespace Express {
    interface Request {
      validated?: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
    }
  }
}

function ensureValidated(req: Request): void {
  if (!req.validated) req.validated = {};
}

// ── validateBody ──────────────────────────────────────────────────────────────

/**
 * Validate req.body against the provided Zod schema.
 * Attaches parsed result to req.validated.body.
 *
 * Usage:
 *   app.post("/api/resource", validateBody(CreateResourceSchema), handler)
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error_code: "VALIDATION_ERROR",
        message: fromZodError(result.error as ZodError).message,
        field: "body",
      });
      return;
    }
    ensureValidated(req);
    req.validated!.body = result.data;
    next();
  };
}

// ── validateParams ────────────────────────────────────────────────────────────

/**
 * Validate req.params against the provided Zod schema.
 * Attaches parsed result to req.validated.params.
 */
export function validateParams<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      res.status(400).json({
        error_code: "VALIDATION_ERROR",
        message: fromZodError(result.error as ZodError).message,
        field: "params",
      });
      return;
    }
    ensureValidated(req);
    req.validated!.params = result.data;
    next();
  };
}

// ── validateQuery ─────────────────────────────────────────────────────────────

/**
 * Validate req.query against the provided Zod schema.
 * Attaches parsed result to req.validated.query.
 */
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error_code: "VALIDATION_ERROR",
        message: fromZodError(result.error as ZodError).message,
        field: "query",
      });
      return;
    }
    ensureValidated(req);
    req.validated!.query = result.data;
    next();
  };
}
