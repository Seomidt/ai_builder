import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";
import { json, err, readBody } from "./_lib/response.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return err(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed");

  const auth = await authenticate(req);
  if (auth.status !== "ok") {
    await readBody(req);
    return json(res, { ok: true });
  }

  await readBody(req);
  return json(res, { ok: true });
}
