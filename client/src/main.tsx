import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n/i18n";
import { initSupabaseFromConfig } from "@/lib/supabase";

// Initialise Supabase client from /api/auth/config BEFORE React renders.
// This ensures the real Supabase URL + anon key are in place even when
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set as Vercel build-time vars.
await initSupabaseFromConfig();

createRoot(document.getElementById("root")!).render(<App />);
