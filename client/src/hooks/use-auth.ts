/**
 * useAuth — Session state hook (reactive via Supabase onAuthStateChange)
 *
 * Flow:
 *   1. Supabase loads session from localStorage (async on page load)
 *   2. onAuthStateChange fires INITIAL_SESSION → supabaseReady = true
 *   3. Only THEN do we call /api/auth/session with the Bearer token
 *   4. Backend validates JWT → returns user info (org, role)
 *
 * This eliminates the race condition where getSession() was called
 * before Supabase finished initializing from localStorage.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase, getSessionToken } from "@/lib/supabase";

export interface SessionUser {
  id: string;
  email?: string;
  organizationId: string;
  role: string;
}

interface SessionResult {
  status: number;
  user: SessionUser | null;
}

async function fetchSession(): Promise<SessionResult> {
  try {
    const token = await getSessionToken();

    if (!token) {
      return { status: 401, user: null };
    }

    const res = await fetch("/api/auth/session", {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
      cache: "no-store",
    });

    if (res.status === 401) return { status: 401, user: null };
    if (res.status === 403) return { status: 403, user: null };
    if (!res.ok) return { status: res.status, user: null };

    const data = (await res.json()) as { user: SessionUser };
    return { status: 200, user: data.user ?? null };
  } catch {
    return { status: 0, user: null };
  }
}

export function useAuth() {
  const [supabaseReady, setSupabaseReady] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event) => {
      setSupabaseReady(true);
      queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
    });

    return () => subscription.unsubscribe();
  }, [queryClient]);

  const { data, isLoading: queryLoading } = useQuery<SessionResult>({
    queryKey: ["/api/auth/session"],
    queryFn: fetchSession,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: supabaseReady,
  });

  const isLoading = !supabaseReady || queryLoading;
  const status = data?.status ?? null;
  const user = data?.user ?? null;

  return {
    isLoading,
    user,
    status,
    isAuthed: status === 200 && user !== null,
    isLockdown: status === 403,
  };
}
