import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n/i18n";

// Supabase client is initialised synchronously in @/lib/supabase using
// baked-in public values — no boot-blocking network call needed.
createRoot(document.getElementById("root")!).render(<App />);
