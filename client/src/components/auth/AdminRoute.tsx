/**
 * AdminRoute — Client-side platform_admin guard
 *
 * Behavior:
 *   isLoading (localStorage, <5ms)          → spinner (BootSpinner)
 *   isAuthed && user === null (backend loading) → spinner (waits for backend-verified role)
 *   user.role !== "platform_admin"          → clean Access Denied (no data fetch)
 *   user.role === "platform_admin"          → render children
 *
 * Security contract:
 *   - Role is taken from backend-verified session (useAuth → /api/auth/session)
 *   - Frontend hiding is UX only; backend enforces platform_admin on /api/admin/*
 *   - No ops queries mount before access is confirmed
 *   - No polling/retry loops on forbidden access
 */

import { Redirect, Link } from "wouter";
import { ShieldAlert, ArrowLeft } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

function AdminSpinner() {
  return (
    <div className="flex items-center justify-center flex-1 h-full" data-testid="admin-route-loading">
      <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function OpsAccessDenied() {
  return (
    <div
      className="flex-1 flex items-center justify-center p-8"
      data-testid="ops-access-denied"
    >
      <div className="max-w-sm text-center space-y-4">
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-destructive/10 mx-auto">
          <ShieldAlert className="w-7 h-7 text-destructive" />
        </div>
        <div>
          <h1
            className="text-lg font-semibold text-foreground mb-1"
            data-testid="text-access-denied-title"
          >
            Adgang nægtet
          </h1>
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-access-denied-message"
          >
            Platform Operations kræver platform admin-adgang. Din konto har
            ikke de nødvendige rettigheder.
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          data-testid="link-access-denied-back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Tilbage til dashboard
        </Link>
      </div>
    </div>
  );
}

interface AdminRouteProps {
  children: React.ReactNode;
}

export function AdminRoute({ children }: AdminRouteProps) {
  const { isLoading, isAuthed, user } = useAuth();

  // Phase 1: localStorage check (< 5ms) — show spinner
  if (isLoading) {
    return <AdminSpinner />;
  }

  // Not authenticated at all — redirect to login
  if (!isAuthed) {
    return <Redirect to="/auth/login" />;
  }

  // Phase 2: authenticated but backend session not yet returned role
  // user is null while /api/auth/session is in-flight (~200-500ms)
  // Do NOT mount ops content or start queries before role is confirmed
  if (!user) {
    return <AdminSpinner />;
  }

  // Phase 3: backend role confirmed — check platform_admin
  if (user.role !== "platform_admin") {
    return <OpsAccessDenied />;
  }

  // Confirmed platform_admin — render ops content
  return <>{children}</>;
}
