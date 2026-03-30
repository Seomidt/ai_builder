import type { IncomingMessage, ServerResponse } from "http";
import { json, err, readBody } from "./_lib/response.ts";
import pg from "pg";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== "POST") return err(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed");

  const body = await readBody<{
    email?:    string;
    fullName?: string;
    company?:  string;
    role?:     string;
    useCase?:  string;
    teamSize?: string;
  }>(req);

  const email   = body.email?.trim().toLowerCase();
  const company = body.company?.trim();

  if (!email)   return err(res, 400, "VALIDATION_ERROR", "Email is required");
  if (!company) return err(res, 400, "VALIDATION_ERROR", "Company is required");

  const client = getClient();
  await client.connect();

  try {
    // Ensure table exists (idempotent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS early_access_applications (
        id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        email      text NOT NULL,
        full_name  text,
        company    text,
        role       text,
        use_case   text,
        team_size  text,
        created_at timestamp DEFAULT now() NOT NULL
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ea_email_uq ON early_access_applications (email)
    `);

    // Check for duplicate
    const existing = await client.query(
      "SELECT id FROM early_access_applications WHERE email = $1 LIMIT 1",
      [email],
    );

    if (existing.rows.length > 0) {
      const response = Object.assign(CORS_HEADERS, {});
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ status: "already_registered" }));
      return;
    }

    await client.query(
      `INSERT INTO early_access_applications (email, full_name, company, role, use_case, team_size)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [email, body.fullName ?? null, company, body.role ?? null, body.useCase ?? null, body.teamSize ?? null],
    );

    res.writeHead(201, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ status: "ok" }));
  } catch (e) {
    console.error("[early-access]", (e as Error).message);
    return err(res, 500, "INTERNAL_ERROR", "Server error. Please try again.");
  } finally {
    await client.end().catch(() => {});
  }
}
