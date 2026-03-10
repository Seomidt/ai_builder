import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { db } from "../db";
import { organizationMembers } from "@shared/schema";
import { eq } from "drizzle-orm";

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
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    req.user = getDemoUser();
    return next();
  }

  const token = authHeader.slice(7);

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user) {
      req.user = getDemoUser();
      return next();
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

    return next();
  } catch {
    req.user = getDemoUser();
    return next();
  }
}

function getDemoUser(): AuthUser {
  return {
    id: "demo-user",
    email: "demo@example.com",
    organizationId:
      (process.env.DEFAULT_ORG_ID as string) ?? "demo-org",
    role: "owner",
  };
}
