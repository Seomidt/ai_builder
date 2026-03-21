/**
 * App — Root entry point with hostname-based domain split.
 *
 * Domain routing:
 *   blissops.com        → TenantApp  (product surface)
 *   admin.blissops.com  → AdminApp   (platform ops surface)
 *
 * Local dev:
 *   localhost           → TenantApp
 *   admin.localhost     → AdminApp
 *
 * Auth routes (/auth/*) are accessible on BOTH domains:
 *   - Supabase callbacks arrive on any domain
 *   - Invite links / password-reset must work regardless of which domain opens
 *
 * SECURITY:
 *   Domain detection controls only which UI shell is rendered.
 *   All backend authorization (AdminRoute + /api/auth/session) remains mandatory.
 *   NEVER trust hostname for access control decisions.
 */

import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { Switch, Route } from "wouter";
import { getAppContext } from "@/lib/runtime/domain";

// ── Auth pages — shared across both domains ───────────────────────────────────
import AuthLogin               from "@/pages/auth/login";
import AuthPasswordResetRequest from "@/pages/auth/password-reset-request";
import AuthPasswordResetConfirm from "@/pages/auth/password-reset-confirm";
import AuthEmailVerify          from "@/pages/auth/email-verify";
import AuthInviteAccept         from "@/pages/auth/invite-accept";
import AuthMfaChallenge         from "@/pages/auth/mfa-challenge";
import AuthCallback             from "@/pages/auth/callback";

// ── Domain-split app shells ───────────────────────────────────────────────────
import { AdminApp }  from "@/apps/admin/AdminApp";
import { TenantApp } from "@/apps/tenant/TenantApp";

// Computed once at boot — hostname does not change during a session.
const appContext = getAppContext(window.location.hostname);

function Router() {
  return (
    <Switch>
      {/* Auth routes — accessible on both domains */}
      <Route path="/auth/login"                  component={AuthLogin} />
      <Route path="/auth/password-reset"         component={AuthPasswordResetRequest} />
      <Route path="/auth/password-reset-confirm" component={AuthPasswordResetConfirm} />
      <Route path="/auth/email-verify"           component={AuthEmailVerify} />
      <Route path="/auth/invite-accept"          component={AuthInviteAccept} />
      <Route path="/auth/callback"               component={AuthCallback} />
      <Route path="/auth/mfa-challenge"          component={AuthMfaChallenge} />

      {/* Domain-split catch-all */}
      <Route>
        {() =>
          appContext === "admin" ? <AdminApp /> : <TenantApp />
        }
      </Route>
    </Switch>
  );
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
