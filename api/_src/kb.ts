/**
 * api/_src/kb.ts — Vercel Serverless Function for /api/kb/*
 *
 * Routes all knowledge base requests through the Express app
 * (Drizzle ORM, pgvector, busboy multipart — too complex for a thin handler).
 */

import "../../server/lib/env";
import type { IncomingMessage, ServerResponse } from "http";

let _appPromise: Promise<any> | null = null;

function loadApp() {
  if (!_appPromise) {
    _appPromise = import("../../server/app")
      .then((m) => m.getApp())
      .catch((err) => {
        _appPromise = null;
        throw err;
      });
  }
  return _appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await loadApp();
    app(req, res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vercel/kb] Cold-start failure:", message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error_code: "COLD_START_FAILURE", message }));
    }
  }
}
