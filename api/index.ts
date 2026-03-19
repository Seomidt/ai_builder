/**
 * api/index.ts — Vercel Serverless Function entry point
 *
 * Pre-bundled by esbuild during `npm run build` → api/index.js
 * All /api/* requests are routed here via vercel.json rewrites.
 * Express app is initialised once per cold-start via getApp() singleton.
 */

import "../server/lib/env";
import type { IncomingMessage, ServerResponse } from "http";
import { getApp } from "../server/app";

let _appPromise: Promise<ReturnType<typeof getApp>> | null = null;

function loadApp() {
  if (!_appPromise) {
    _appPromise = getApp().catch((err) => {
      _appPromise = null;
      throw err;
    });
  }
  return _appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await loadApp();
    app(req, res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    console.error("[vercel] Cold-start failure:", message);
    if (stack) console.error("[vercel] Stack:", stack);

    console.error("[vercel] Env check:", {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_DB_POOL_URL: !!process.env.SUPABASE_DB_POOL_URL,
      DATABASE_URL: !!process.env.DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
    });

    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error_code: "COLD_START_FAILURE",
          message: "Server initialization failed.",
          detail: message,
          env_check: {
            has_supabase_url: !!process.env.SUPABASE_URL,
            has_anon_key: !!process.env.SUPABASE_ANON_KEY,
            has_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
            has_db_url: !!(process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL),
          },
        }),
      );
    }
  }
}
