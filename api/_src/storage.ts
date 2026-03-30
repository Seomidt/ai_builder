import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";
import { json, err } from "./_lib/response.ts";

const CF_ACCOUNT_ID        = process.env.CF_R2_ACCOUNT_ID   ?? "";
const CF_R2_BUCKET_NAME    = process.env.CF_R2_BUCKET_NAME  ?? "";
const CF_R2_ACCESS_KEY_ID  = process.env.CF_R2_ACCESS_KEY_ID ?? "";
const CF_R2_SECRET_KEY     = process.env.CF_R2_SECRET_ACCESS_KEY ?? "";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");

  return json(res, {
    provider:   "cloudflare-r2",
    bucket:     CF_R2_BUCKET_NAME || null,
    configured: !!(CF_ACCOUNT_ID && CF_R2_BUCKET_NAME && CF_R2_ACCESS_KEY_ID && CF_R2_SECRET_KEY),
  });
}
