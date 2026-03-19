/**
 * Phase 43 — CSP Violation Reporting Endpoint
 *
 * POST /api/security/csp-report
 *
 * Accepts browser CSP violation reports (Content-Security-Policy-Report-Only
 * and enforced CSP reports).
 *
 * Requirements (Phase 43 Task 8):
 *   - Accept CSP violation reports safely
 *   - Validate payload shape (reject malformed / silently discard)
 *   - Rate-limit to prevent noise flooding
 *   - Structured logging of useful fields only
 *   - No excessive logging of browser-extension noise
 *   - Record: violated-directive, blocked-uri, document-uri, effective-directive,
 *             original-policy, user-agent, timestamp
 *
 * INV-CSP-1: Endpoint must not require authentication (CSP reports come from browser)
 * INV-CSP-2: Payload is validated before logging — invalid payloads silently discarded
 * INV-CSP-3: Rate-limited per IP to prevent abuse
 * INV-CSP-4: No PII logged (body, cookies, auth headers excluded)
 */

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import express from "express";
import { z } from "zod";
import { logSecurityEvent } from "../lib/security/security-events";

export const cspReportRouter = Router();

// ── Body parser for CSP content types ────────────────────────────────────────
// Browsers send CSP reports as application/csp-report (JSON body).
// The global express.json() only parses application/json — we need an explicit parser here.
const cspBodyParser = express.json({
  type: ["application/json", "application/csp-report", "application/reports+json"],
  limit: "64kb",  // CSP reports are tiny — generous cap prevents abuse
});

// ── Rate limiter — prevent flooding ──────────────────────────────────────────
// 30 reports per minute per IP — generous enough for legitimate browsers,
// tight enough to prevent DoS via CSP report flooding.
const cspReportLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minute window
  max: 30,                 // max 30 per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).end(); // silent 429 — browsers ignore the response body
  },
});

// ── Payload schemas ───────────────────────────────────────────────────────────

const CspViolationSchema = z.object({
  "document-uri":         z.string().max(2048).optional(),
  "referrer":             z.string().max(2048).optional(),
  "violated-directive":   z.string().max(512).optional(),
  "effective-directive":  z.string().max(512).optional(),
  "original-policy":      z.string().max(4096).optional(),
  "blocked-uri":          z.string().max(2048).optional(),
  "status-code":          z.number().optional(),
  "source-file":          z.string().max(2048).optional(),
  "line-number":          z.number().optional(),
  "column-number":        z.number().optional(),
  "script-sample":        z.string().max(512).optional(),
  "disposition":          z.enum(["enforce", "report"]).optional(),
}).passthrough();

const CspReportBodySchema   = z.object({ "csp-report": CspViolationSchema });

const ReportingApiItemSchema = z.object({
  type: z.string().max(128),
  url:  z.string().max(2048).optional(),
  age:  z.number().optional(),
  body: CspViolationSchema.optional(),
});

const ReportingApiSchema = z.array(ReportingApiItemSchema);

// ── Noise filter ──────────────────────────────────────────────────────────────
// Browser extensions and ISPs frequently inject content, producing spurious CSP
// violations. These are not our violations and must not pollute security event logs.
const NOISE_PREFIXES = new Set([
  "chrome-extension",
  "moz-extension",
  "safari-extension",
  "ms-browser-extension",
  "about",
]);

function isNoisyReport(blockedUri: string | undefined): boolean {
  if (!blockedUri) return false;
  const prefix = blockedUri.split(":")[0].toLowerCase();
  return NOISE_PREFIXES.has(prefix);
}

// ── Log helper ────────────────────────────────────────────────────────────────

function handleCspViolation(
  report: z.infer<typeof CspViolationSchema>,
  req: Request,
): void {
  const blockedUri = report["blocked-uri"] ?? "";
  if (isNoisyReport(blockedUri)) return; // discard browser-extension noise

  const userAgent  = (req.headers["user-agent"] ?? "").toString().slice(0, 256);
  const requestId  = (req as any).requestId ?? "unknown";
  const ip         = req.ip ?? null;

  // Fire-and-forget — never await in CSP handler to keep latency near zero
  logSecurityEvent({
    eventType: "security_header_violation",
    ip,
    userAgent,
    requestId,
    metadata: {
      violationType:       "csp_violation",
      violatedDirective:   report["violated-directive"] ?? "unknown",
      effectiveDirective:  report["effective-directive"] ?? report["violated-directive"] ?? "unknown",
      blockedUri:          blockedUri.slice(0, 256),
      documentUri:         (report["document-uri"] ?? "").slice(0, 256),
      originalPolicy:      (report["original-policy"] ?? "").slice(0, 512),
      disposition:         report["disposition"] ?? "enforce",
      sourceFile:          (report["source-file"] ?? "").slice(0, 256),
      lineNumber:          report["line-number"],
      columnNumber:        report["column-number"],
      scriptSample:        (report["script-sample"] ?? "").slice(0, 128),
      timestamp:           new Date().toISOString(),
    },
  }).catch(() => {
    // Observability failure must never propagate
  });
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

/**
 * POST /api/security/csp-report
 *
 * Accepts:
 *   application/csp-report        (W3C Level 1 — classic CSP report)
 *   application/reports+json      (W3C Reporting API Level 2)
 *   application/json              (fallback, some browsers)
 *
 * INV-CSP-1: No auth required — registered before authMiddleware in index.ts
 * INV-CSP-3: Rate limited above
 */
cspReportRouter.post(
  "/csp-report",
  cspReportLimiter,
  cspBodyParser,
  (req: Request, res: Response) => {
    // Always 204 immediately — browsers ignore response bodies
    res.status(204).end();

    try {
      const body  = req.body;
      if (!body || typeof body !== "object") return;

      const ctype = (req.headers["content-type"] ?? "").toLowerCase();

      // W3C Reporting API format: array of report objects
      if (ctype.includes("application/reports+json") || Array.isArray(body)) {
        const parsed = ReportingApiSchema.safeParse(body);
        if (!parsed.success) return;
        for (const item of parsed.data) {
          if (item.body) handleCspViolation(item.body, req);
        }
        return;
      }

      // Classic CSP format: { "csp-report": { ... } }
      const parsed = CspReportBodySchema.safeParse(body);
      if (!parsed.success) return;
      handleCspViolation(parsed.data["csp-report"], req);

    } catch {
      // Never let CSP report processing crash the server
    }
  },
);

/**
 * GET /api/security/csp-report
 * Health check — used by validate-phase43.ts to confirm endpoint is registered.
 */
cspReportRouter.get("/csp-report", (_req: Request, res: Response) => {
  res.json({ status: "ok", endpoint: "csp-report", accepts: ["POST"] });
});
