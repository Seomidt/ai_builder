import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err } from "./_lib/response";

const FEATURE_FLAGS: Record<string, boolean> = {
  aiEvals:          false,
  billingOps:       false,
  multiOrg:         false,
  advancedAnalytics: false,
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return err(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed");

  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");

  const { user } = auth;

  return json(res, {
    phase:        "production",
    environment:  process.env.NODE_ENV ?? "production",
    features:     FEATURE_FLAGS,
    user: {
      id:             user.id,
      email:          user.email,
      organizationId: user.organizationId,
      role:           user.role,
      isPlatformAdmin: user.role === "platform_admin",
    },
  });
}
