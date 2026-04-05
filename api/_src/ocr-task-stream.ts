import "../../server/lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";

export const config = {
  supportsResponseStreaming: true,
  maxDuration: 120,
};

const RAILWAY_URL = (
  process.env.RAILWAY_BACKEND_URL ||
  process.env.BACKEND_URL ||
  "https://blissops-production.up.railway.app"
).replace(/\/$/, "");

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error_code: "METHOD_NOT_ALLOWED", message: "GET only" }));
    return;
  }

  const auth = await authenticate(req);
  if (auth.status !== "ok" || !auth.user) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error_code: "UNAUTHENTICATED", message: "Login påkrævet" }));
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error_code: "MISSING_TASK_ID", message: "taskId er påkrævet" }));
    return;
  }

  const authHeader = req.headers.authorization ?? "";

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  try {
    const upstream = await fetch(
      `${RAILWAY_URL}/api/ocr-task-stream?taskId=${encodeURIComponent(taskId)}`,
      {
        method: "GET",
        headers: {
          "Authorization": authHeader,
          "Accept": "text/event-stream",
        },
        signal: ac.signal,
      },
    );

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(errText || JSON.stringify({ error_code: "UPSTREAM_ERROR", message: `Railway HTTP ${upstream.status}` }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        if (typeof (res as any).flush === "function") (res as any).flush();
      }
    } catch {
    } finally {
      reader.cancel().catch(() => {});
      if (!res.writableEnded) res.end();
    }
  } catch (err: any) {
    if (ac.signal.aborted) return;
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error_code: "PROXY_ERROR", message: err?.message ?? "Kan ikke nå backend" }));
    }
  }
}
