/**
 * api/index.ts — Vercel Serverless Function entry point
 *
 * Vercel routes all /api/* requests here via vercel.json rewrites.
 * Express app is initialised once per cold-start (singleton via getApp()).
 */

import "./lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";

let _appPromise: Promise<any> | null = null;

function loadApp() {
  if (!_appPromise) {
    _appPromise = import("../server/app").then((m) => m.getApp());
  }
  return _appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await loadApp();
    app(req, res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vercel] Cold-start failure:", message);

    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error_code: "COLD_START_FAILURE",
          message: "Server initialization failed. Check Vercel env vars.",
          detail: message,
        }),
      );
    }
  }
}
