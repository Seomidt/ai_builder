/**
 * api/index.ts — Vercel Serverless Function entry point
 *
 * Vercel compiles and deploys this file natively (no esbuild pre-bundling needed).
 * All /api/* requests are routed here via vercel.json rewrites.
 * Express app is initialised once per cold-start via getApp() singleton.
 */

import "../server/lib/env";
import type { IncomingMessage, ServerResponse } from "http";
import { getApp } from "../server/app";

let _appPromise: Promise<ReturnType<typeof getApp>> | null = null;

function loadApp() {
  if (!_appPromise) {
    _appPromise = getApp();
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
