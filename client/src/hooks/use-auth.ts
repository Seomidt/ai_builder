/**
 * useAuth — Client-side auth gate using Supabase SDK
 *
 * AUTH GATE: Based entirely on the Supabase session (client-side).
 * The SDK verifies the JWT cryptographically — no backend call needed.
 *
 * ENRICHMENT: Backend /api/auth/session is called in background to get
 * organizationId and role. Falls back to defaults if backend is unavailable.
 *
 * This means:
 *  - Login works even if backend env vars are not set
 *  - No login loop — 401 from backend never causes a redirect
 *  - SIGNED_OUT still clears everything correctly
 */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export interface SessionUser {
  id: string;
  email?: string;
  organizationId: string;
  role: string;
}

interface BackendEnrichment {
  organizationId: string;
  role: string;
}

// Module-level token — survives re-mounts, set by onAuthStateChange
let _cachedToken: string | null = null;

async function fetchEnrichment(token: string | null): Promise<BackendEnrichment | null> {
  if (!token) return null;
  try {
    const res = await fetch("/api/auth/session", {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: { organizationId?: string; role?: string } };
    if (!data.user) return null;
    return {
      organizationId: data.user.organizationId ?? "blissops-main",
      role:           data.user.role           ?? "member",
    };
  } catch {
    return null;
  }
}

// Platform admins — email-based fallback when backend enrichment is unavailable
const PLATFORM_ADMIN_EMAILS = new Set(
  (import.meta.env.VITE_PLATFORM_ADMIN_EMAILS ?? "seomidt@gmail.com")
    .split(",").map((e: string) => e.trim().toLowerCase()).filter(Boolean),
);

// Lockdown: checked client-side from env var
const LOCKDOWN_ENABLED   = import.meta.env.VITE_LOCKDOWN_ENABLED === "true";
const LOCKDOWN_ALLOWLIST = new Set(
  (import.meta.env.VITE_LOCKDOWN_ALLOWLIST ?? "seomidt@gmail.com")
    .split(",").map((e: string) => e.trim().toLowerCase()).filter(Boolean),
);

export function useAuth() {
  const queryClient = useQueryClient();

  // Auth gate state — based on Supabase session only
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    // Read session from localStorage (synchronous in v2 internals, async API)
    supabase.auth.getSession().then(({ data }) => {
      _cachedToken = data.session?.access_token ?? null;
      setSession(data.session ?? null);
    });
  }, []);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, sess) => {
      _cachedToken = sess?.access_token ?? null;
      setSession(sess ?? null);

      if (event === "SIGNED_OUT") {
        _cachedToken = null;
        queryClient.removeQueries({ queryKey: ["/api/auth/enrichment"] });
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        // Invalidate enrichment so it re-fetches with the fresh token
        queryClient.invalidateQueries({ queryKey: ["/api/auth/enrichment"] });
      }
    });

    return () => subscription.unsubscribe();
  }, [queryClient]);

  // Background enrichment — does NOT block auth gate, tolerates backend failure
  const { data: enrichment } = useQuery<BackendEnrichment | null>({
    queryKey: ["/api/auth/enrichment"],
    queryFn:  () => fetchEnrichment(_cachedToken),
    enabled:  session !== undefined && session !== null,
    retry:    1,
    staleTime: 120_000,
    gcTime:    300_000,
    refetchOnWindowFocus: false,
  });

  // ── Derived state ────────────────────────────────────────────────────────────

  // isLoading: true until we know whether there is a session or not
  const isLoading = session === undefined;

  // isAuthed: Supabase session exists (SDK verified the JWT)
  const isAuthed = session !== null && session !== undefined;

  // Lockdown: only active if VITE_LOCKDOWN_ENABLED=true and email not allowlisted
  const email = session?.user?.email?.toLowerCase() ?? "";
  const isLockdown =
    LOCKDOWN_ENABLED &&
    isAuthed &&
    email !== "" &&
    !LOCKDOWN_ALLOWLIST.has(email);

  // User object: backend enrichment → Supabase metadata → email-based fallback
  const isPlatformAdmin = PLATFORM_ADMIN_EMAILS.has(email);
  const user: SessionUser | null = isAuthed && session
    ? {
        id:             session.user.id,
        email:          session.user.email,
        organizationId: enrichment?.organizationId ?? "blissops-main",
        role:           enrichment?.role
                          ?? session.user.user_metadata?.role
                          ?? (isPlatformAdmin ? "platform_admin" : "member"),
      }
    : null;

  return {
    isLoading,
    isAuthed,
    isLockdown,
    user,
    status: isAuthed ? 200 : 401,
  };
}
