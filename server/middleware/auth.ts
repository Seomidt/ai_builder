/**
 * Authentication middleware.
 *
 * Hardening (Phase 13.1):
 *   - Demo user only allowed when DEMO_MODE=true in environment.
 *   - If no token and DEMO_MODE != "true": returns 401 Unauthorized.
 *   - Demo users always get role=viewer (never owner), random user ID, tenant=demo-org.
 *   - Invalid tokens no longer fall back to demo user — they return 401.
 *   - Authenticated users keep full role from DB (unchanged behavior).
 */

import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { db } from "../db";
import { organizationMembers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { mapCurrentUserToCanonicalActor } from "../lib/auth/identity-compat";
import type { ResolvedActor } from "../lib/auth/actor-resolution";

export interface AuthUser {
  id: string;
  email?: string;
  organizationId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      resolvedActor?: ResolvedActor;
    }
  }
}

// ── Demo mode guard ───────────────────────────────────────────────────────────

function isDemoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}

function getDemoUser(): AuthUser {
  return {
    id: `demo-${randomUUID()}`,
    email: "demo@example.com",
    organizationId: "demo-org",
    role: "viewer", // Never grant owner privileges to demo users
  };
}

// ── Auth middleware ───────────────────────────────────────────────────────────

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  // ── No token: demo fallback (only if DEMO_MODE=true) ─────────────────────
  if (!authHeader?.startsWith("Bearer ")) {
    if (!isDemoModeEnabled()) {
      res.status(401).json({
        error_code: "UNAUTHORIZED",
        message: "Authentication required. Provide a Bearer token.",
      });
      return;
    }
    req.user = getDemoUser();
    req.resolvedActor = mapCurrentUserToCanonicalActor(req.user);
    return next();
  }

  const token = authHeader.slice(7);

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    // ── Invalid token: fail closed (no demo fallback) ─────────────────────
    if (error || !data.user) {
      res.status(401).json({
        error_code: "UNAUTHORIZED",
        message: "Invalid or expired authentication token.",
      });
      return;
    }

    const members = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, data.user.id))
      .limit(1);

    const member = members[0];

    req.user = {
      id: data.user.id,
      email: data.user.email,
      organizationId: member?.organizationId ?? "demo-org",
      role: member?.role ?? "member",
    };

    // Phase 6: attach canonical resolved actor for permission-code based checks.
    // INV-ID9: backward-compatible — req.user remains untouched.
    req.resolvedActor = mapCurrentUserToCanonicalActor(req.user);

    return next();
  } catch {
    // DB failure: fail closed — do NOT fall back to demo user
    res.status(401).json({
      error_code: "UNAUTHORIZED",
      message: "Authentication check failed. Please try again.",
    });
  }
}
