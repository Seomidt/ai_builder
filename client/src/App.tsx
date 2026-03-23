import { Component, type ReactNode } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/components/providers/I18nProvider";
import { Switch, Route } from "wouter";
import { getAppContext } from "@/lib/runtime/domain";

import AuthLogin               from "@/pages/auth/login";
import AuthPasswordResetRequest from "@/pages/auth/password-reset-request";
import AuthPasswordResetConfirm from "@/pages/auth/password-reset-confirm";
import AuthEmailVerify          from "@/pages/auth/email-verify";
import AuthInviteAccept         from "@/pages/auth/invite-accept";
import AuthMfaChallenge         from "@/pages/auth/mfa-challenge";
import AuthCallback             from "@/pages/auth/callback";

import { MarketingApp } from "@/apps/marketing/MarketingApp";
import { AdminApp }     from "@/apps/admin/AdminApp";
import { TenantApp }    from "@/apps/tenant/TenantApp";

const appContext = getAppContext(window.location.hostname);

// ── Error Boundary — catches React render errors (shows message instead of white screen) ──
interface EBState { error: Error | null }
class AppErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(e: Error): EBState { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "2rem", fontFamily: "monospace", maxWidth: 600, margin: "4rem auto" }}>
          <h2 style={{ color: "#ef4444" }}>Something went wrong</h2>
          <pre style={{ background: "#1e293b", color: "#f8fafc", padding: "1rem", borderRadius: 8, overflowX: "auto", fontSize: 12 }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{ marginTop: "1rem", padding: "0.5rem 1rem", background: "#22d3ee", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function MarketingRouter() {
  return <MarketingApp />;
}

function AuthenticatedRouter() {
  return (
    <Switch>
      <Route path="/auth/login"                  component={AuthLogin} />
      <Route path="/auth/password-reset"         component={AuthPasswordResetRequest} />
      <Route path="/auth/password-reset-confirm" component={AuthPasswordResetConfirm} />
      <Route path="/auth/email-verify"           component={AuthEmailVerify} />
      <Route path="/auth/invite-accept"          component={AuthInviteAccept} />
      <Route path="/auth/callback"               component={AuthCallback} />
      <Route path="/auth/mfa-challenge"          component={AuthMfaChallenge} />
      <Route>
        {() => appContext === "admin" ? <AdminApp /> : <TenantApp />}
      </Route>
    </Switch>
  );
}

function Router() {
  if (appContext === "marketing") return <MarketingRouter />;
  return <AuthenticatedRouter />;
}

function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

export default App;
