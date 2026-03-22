import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n/i18n";

// preWarm: fire an unauthenticated request to the health endpoint BEFORE
// React renders. On a cold Vercel serverless start, the first backend request
// takes 10-15 s (2.2 MB bundle parse + module init + Supabase pool setup).
// Firing this ~400 ms before the first real API call overlaps most of that
// cold-start with JS parse + React init → user sees content faster.
// Fire-and-forget: we ignore the response (no auth, no side effects).
(function preWarm() {
  try {
    fetch("/api/admin/platform/deploy-health", {
      method: "GET",
      cache: "no-store",
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
})();

// Supabase client is initialised synchronously in @/lib/supabase using
// baked-in public values — no boot-blocking network call needed.
createRoot(document.getElementById("root")!).render(<App />);
