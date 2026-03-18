/**
 * Phase 6 — Request Context & Middleware Helpers
 * INV-ID9: Backward compatible — does not break existing route protection.
 */

import type { Request, Response, NextFunction } from "express";
import { resolveRequestActor } from "./actor-resolution";
import type { ResolvedActor } from "./actor-resolution";
import { explainPermissionDecision } from "./permissions";
import { mapCurrentUserToCanonicalActor } from "./identity-compat";

declare global {
  namespace Express {
    interface Request {
      resolvedActor?: ResolvedActor;
    }
  }
}

// ─── attachResolvedActorToRequest ─────────────────────────────────────────────
// Middleware that maps req.user to canonical actor and attaches to req.
// INV-ID9: Falls back to legacy req.user — never breaks existing routes.

export function attachResolvedActorToRequest(req: Request, _res: Response, next: NextFunction): void {
  if (req.resolvedActor) return next();
  if (req.user) {
    req.resolvedActor = mapCurrentUserToCanonicalActor(req.user);
  }
  next();
}

// ─── requireRequestPermission ─────────────────────────────────────────────────

export function requireRequestPermission(permissionCode: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = req.resolvedActor ?? (req.user ? mapCurrentUserToCanonicalActor(req.user) : null);
    if (!actor) {
      res.status(401).json({ error: "Unauthenticated", reasonCode: "ACTOR_NOT_RESOLVED" });
      return;
    }
    if (!actor.permissionCodes.includes(permissionCode)) {
      res.status(403).json({
        error: `Permission denied: ${permissionCode}`,
        reasonCode: "PERMISSION_NOT_GRANTED",
        actorType: actor.actorType,
      });
      return;
    }
    next();
  };
}

// ─── requireInternalAdminPermission ──────────────────────────────────────────
// For admin/internal routes. Accepts demo/system actors as valid.
// INV-ID9: All existing admin routes continue working (demo actor has all perms).

export function requireInternalAdminPermission(permissionCode: string = "admin.internal.read") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = req.resolvedActor ?? (req.user ? mapCurrentUserToCanonicalActor(req.user) : null);
    if (!actor) {
      res.status(401).json({ error: "Unauthenticated", reasonCode: "ACTOR_NOT_RESOLVED" });
      return;
    }
    if (actor.isSystemActor || actor.permissionCodes.includes(permissionCode)) {
      return next();
    }
    res.status(403).json({
      error: `Internal admin permission required: ${permissionCode}`,
      reasonCode: "INTERNAL_ONLY_ROUTE",
    });
  };
}

// ─── explainRequestAccess ─────────────────────────────────────────────────────

export function explainRequestAccess(req: Request, permissionCode: string): {
  resolved: boolean;
  actorType?: string;
  tenantId?: string | null;
  permissionCode: string;
  granted: boolean;
  note: string;
} {
  const actor = req.resolvedActor ?? (req.user ? mapCurrentUserToCanonicalActor(req.user) : null);
  if (!actor) {
    return {
      resolved: false,
      permissionCode,
      granted: false,
      note: "INV-ID9: No actor resolved. Legacy unauthenticated request.",
    };
  }
  const decision = explainPermissionDecision(actor, permissionCode);
  return {
    resolved: true,
    actorType: actor.actorType,
    tenantId: actor.tenantId,
    permissionCode,
    granted: decision.granted,
    note: "INV-ID9: Canonical actor resolved for request access check.",
  };
}
