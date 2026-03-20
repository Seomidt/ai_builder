/**
 * ProtectedRoute — Client-side auth guard (optimistic)
 *
 * Behavior:
 *   isLoading (< 5ms localStorage read) → minimal spinner
 *   hasLocalSession = true              → render children immediately (optimistic)
 *   backend returns 401/403             → redirect / lockdown (after async check)
 *   no local session                    → redirect to /auth/login instantly
 *
 * Backend enforcement remains the primary security layer.
 * Frontend renders optimistically using local Supabase session to eliminate
 * the "checking session" delay on refresh.
 */

import { Redirect } from "wouter";
import { useAuth } from "@/hooks/use-auth";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

function BootSpinner() {
  return (
    <div
      className="flex items-center justify-center h-screen bg-background"
      data-testid="auth-loading-screen"
    >
      <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function LockdownScreen() {
  return (
    <div
      className="flex items-center justify-center h-screen bg-background"
      data-testid="auth-lockdown-screen"
    >
      <div className="max-w-md text-center px-6">
        <div className="mb-4 text-4xl">🔒</div>
        <h1 className="text-2xl font-bold mb-2" data-testid="text-lockdown-title">
          Access Restricted
        </h1>
        <p className="text-muted-foreground text-sm" data-testid="text-lockdown-message">
          This platform is in emergency lockdown. Your account is not authorised
          to access this surface. Contact the platform administrator.
        </p>
      </div>
    </div>
  );
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isLoading, isAuthed, isLockdown } = useAuth();

  // Only shown for < 5ms while getSession() reads from localStorage
  if (isLoading) {
    return <BootSpinner />;
  }

  if (isLockdown) {
    return <LockdownScreen />;
  }

  // No local session — redirect immediately without waiting for backend
  if (!isAuthed) {
    return <Redirect to="/auth/login" />;
  }

  // Local session confirmed — render immediately.
  // Backend validation runs in background via useAuth's useQuery.
  // If backend returns 401 (expired token), isAuthed transitions to false
  // and this component re-renders with the redirect.
  return <>{children}</>;
}
