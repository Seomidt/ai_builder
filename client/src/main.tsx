import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n/i18n";

// preWarm: hit /api/auth/config (Vercel Edge, no cold start) before React
// renders. This warms the edge auth function so /api/auth/session returns
// in <200ms when the user's session check fires. Fire-and-forget.
(function preWarm() {
  try {
    fetch("/api/auth/config", {
      method: "GET",
      cache:  "force-cache",
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
})();

// Vite chunk preload error handler: when a lazy-loaded chunk can't be found
// after a Vercel redeployment (new hashes), force a full page reload so the
// browser fetches the new index.html and correct chunk URLs.
window.addEventListener("vite:preloadError", () => {
  window.location.reload();
});

// Supabase client is initialised synchronously in @/lib/supabase using
// baked-in public values — no boot-blocking network call needed.
createRoot(document.getElementById("root")!).render(<App />);
