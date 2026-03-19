/**
 * AuthCallback — Supabase auth callback handler
 *
 * Handles:
 *   - OAuth provider callbacks (Google, GitHub, etc.)
 *   - Magic link callbacks
 *   - Email verification callbacks
 *   - Password reset callbacks (redirected from Supabase)
 *
 * How it works:
 *   Supabase detects the session from the URL hash/query params
 *   via `detectSessionInUrl: true` (set in supabase.ts AUTH_OPTIONS).
 *   We listen for the SIGNED_IN / PASSWORD_RECOVERY event, then redirect.
 *
 * Route: /auth/callback
 * Supabase allow-list: https://blissops.com/auth/callback
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function AuthCallback() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let handled = false;

    // Supabase will automatically detect the session from the URL
    // hash (#access_token=...) or query param (?code=...) when
    // detectSessionInUrl: true is set. We just wait for the event.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (handled) return;

        if (event === "SIGNED_IN" && session) {
          handled = true;

          // Redirect to next param or dashboard
          const params = new URLSearchParams(window.location.search);
          const next = params.get("next");
          const destination =
            next && next.startsWith("/") && !next.startsWith("//")
              ? next
              : "/";

          setLocation(destination);
        }

        if (event === "PASSWORD_RECOVERY") {
          handled = true;
          setLocation("/auth/password-reset-confirm");
        }

        if (event === "INITIAL_SESSION" && !session) {
          // No session after URL processing — likely invalid/expired link
          const params = new URLSearchParams(window.location.search);
          const errorDesc = params.get("error_description");
          setError(errorDesc ?? "Link er ugyldig eller udløbet. Prøv igen.");
        }
      },
    );

    // Fallback: if no event fires within 8 seconds, check manually
    const fallback = setTimeout(async () => {
      if (handled) return;
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        handled = true;
        setLocation("/");
      } else {
        setError("Sessionen kunne ikke bekræftes. Prøv at logge ind igen.");
      }
    }, 8000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(fallback);
    };
  }, [setLocation]);

  if (error) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-background px-4"
        data-testid="page-auth-callback-error"
      >
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="flex justify-center">
            <AlertCircle className="h-10 w-10 text-destructive" />
          </div>
          <h1 className="text-xl font-semibold" data-testid="text-callback-error-title">
            Autentificering fejlede
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-callback-error-message">
            {error}
          </p>
          <a
            href="/auth/login"
            className="inline-block text-sm text-primary underline underline-offset-4"
            data-testid="link-back-to-login"
          >
            Tilbage til login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-background"
      data-testid="page-auth-callback-loading"
    >
      <div className="flex flex-col items-center gap-3">
        <Loader2
          className="h-8 w-8 animate-spin text-primary"
          data-testid="spinner-callback"
        />
        <p className="text-sm text-muted-foreground">Logger ind…</p>
      </div>
    </div>
  );
}
