/**
 * App — Root entry point with canonical 3-surface domain split.
 *
 * CANONICAL DOMAIN MODEL:
 *   blissops.com          → MarketingApp  (public site, no auth shell)
 *   www.blissops.com      → MarketingApp
 *   app.blissops.com      → TenantApp     (authenticated product surface)
 *   admin.blissops.com    → AdminApp      (platform operations surface)
 *
 * LOCAL DEV:
 *   localhost             → TenantApp     (primary dev surface)
 *   app.localhost         → TenantApp
 *   admin.localhost       → AdminApp
 *
 * ROUTING STRATEGY:
 *   - marketing: MarketingApp handles everything (incl. /auth/* redirect to app domain)
 *   - tenant:    Auth routes registered + TenantApp catch-all
 *   - admin:     Auth routes registered + AdminApp catch-all
 *
 * SECURITY:
 *   Domain controls UI surface selection ONLY.
 *   Backend authorization (AdminRoute + /api/auth/session) remains mandatory.
 *   NEVER trust hostname for access control decisions.
 */

import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { Switch, Route } from "wouter";
import { getAppContext } from "@/lib/runtime/domain";

// ── Auth pages — registered on tenant + admin domains ─────────────────────────
import AuthLogin               from "@/pages/auth/login";
import AuthPasswordResetRequest from "@/pages/auth/password-reset-request";
import AuthPasswordResetConfirm from "@/pages/auth/password-reset-confirm";
import AuthEmailVerify          from "@/pages/auth/email-verify";
import AuthInviteAccept         from "@/pages/auth/invite-accept";
import AuthMfaChallenge         from "@/pages/auth/mfa-challenge";
import AuthCallback             from "@/pages/auth/callback";

// ── Domain-split app shells ───────────────────────────────────────────────────
import { MarketingApp } from "@/apps/marketing/MarketingApp";
import { AdminApp }     from "@/apps/admin/AdminApp";
import { TenantApp }    from "@/apps/tenant/TenantApp";

// Computed once at boot — hostname does not change during a session.
const appContext = getAppContext(window.location.hostname);

/**
 * Marketing router: MarketingApp handles ALL routes (incl. /auth/* redirect).
 * No auth shell, no sidebar, no tenant/admin routes.
 */
function MarketingRouter() {
  return <MarketingApp />;
}

/**
 * Authenticated routers (tenant + admin): auth pages first, then app shell.
 * Auth routes are registered so ProtectedRoute/AdminRoute redirects work correctly.
 */
function AuthenticatedRouter() {
  return (
    <Switch>
      {/* Auth routes — Supabase callbacks, login, reset, invite, MFA */}
      <Route path="/auth/login"                  component={AuthLogin} />
      <Route path="/auth/password-reset"         component={AuthPasswordResetRequest} />
      <Route path="/auth/password-reset-confirm" component={AuthPasswordResetConfirm} />
      <Route path="/auth/email-verify"           component={AuthEmailVerify} />
      <Route path="/auth/invite-accept"          component={AuthInviteAccept} />
      <Route path="/auth/callback"               component={AuthCallback} />
      <Route path="/auth/mfa-challenge"          component={AuthMfaChallenge} />

      {/* Domain-split catch-all */}
      <Route>
        {() => appContext === "admin" ? <AdminApp /> : <TenantApp />}
      </Route>
    </Switch>
  );
}

function Router() {
  if (appContext === "marketing") {
    return <MarketingRouter />;
  }
  return <AuthenticatedRouter />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

export default App;
