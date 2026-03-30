import type { IncomingMessage, ServerResponse } from "http";
import { json, err, readBody } from "./_lib/response.ts";
import { dbInsert } from "./_lib/db.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return err(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed");

  try {
    const body = await readBody<{ email?: string; name?: string }>(req);
    if (!body.email) return err(res, 400, "VALIDATION_ERROR", "Email is required");

    const row = await dbInsert("waitlist_entries", {
      email:     body.email,
      name:      body.name ?? null,
      createdAt: new Date().toISOString(),
    });
    return json(res, row, 201);
  } catch (e) {
    return err(res, 500, "INTERNAL_ERROR", (e as Error).message);
  }
}
