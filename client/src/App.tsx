import { lazy, Suspense } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AdminRoute } from "@/components/auth/AdminRoute";
import { I18nProvider } from "@/components/providers/I18nProvider";

// ── Eagerly loaded: core tenant pages ─────────────────────────────────────────
import Dashboard from "@/pages/dashboard";
import Projects from "@/pages/projects";
import Architectures from "@/pages/architectures";
import Runs from "@/pages/runs";
import NotFound from "@/pages/not-found";

// ── Eagerly loaded: auth pages ────────────────────────────────────────────────
import AuthLogin from "@/pages/auth/login";
import AuthPasswordResetRequest from "@/pages/auth/password-reset-request";
import AuthPasswordResetConfirm from "@/pages/auth/password-reset-confirm";
import AuthEmailVerify from "@/pages/auth/email-verify";
import AuthInviteAccept from "@/pages/auth/invite-accept";
import AuthMfaChallenge from "@/pages/auth/mfa-challenge";
import AuthCallback from "@/pages/auth/callback";

// ── Lazy: tenant detail ───────────────────────────────────────────────────────
const RunDetail = lazy(() => import("@/pages/run-detail"));

// ── Lazy: tenant surface (workspace) — own chunk ──────────────────────────────
const TenantDashboard    = lazy(() => import("@/pages/tenant/dashboard"));
const TenantData         = lazy(() => import("@/pages/tenant/data"));
const TenantAI           = lazy(() => import("@/pages/tenant/ai"));
const TenantUsage        = lazy(() => import("@/pages/tenant/usage"));
const TenantBilling      = lazy(() => import("@/pages/tenant/billing"));
const TenantIntegrations = lazy(() => import("@/pages/tenant/integrations"));
const TenantTeam         = lazy(() => import("@/pages/tenant/team"));
const TenantSettings     = lazy(() => import("@/pages/tenant/settings"));
const TenantAudit        = lazy(() => import("@/pages/tenant/audit"));

// ── Lazy: admin platform — not in tenant bundle ───────────────────────────────
const Integrations     = lazy(() => import("@/pages/integrations"));
const Settings         = lazy(() => import("@/pages/settings"));
const SecuritySettings = lazy(() => import("@/pages/settings/security"));

// ── Lazy: Ops console ─────────────────────────────────────────────────────────
const OpsDashboard    = lazy(() => import("@/pages/ops/dashboard"));
const OpsTenants      = lazy(() => import("@/pages/ops/tenants"));
const OpsJobs         = lazy(() => import("@/pages/ops/jobs"));
const OpsWebhooks     = lazy(() => import("@/pages/ops/webhooks"));
const OpsAi           = lazy(() => import("@/pages/ops/ai"));
const OpsBilling      = lazy(() => import("@/pages/ops/billing"));
const OpsRecovery     = lazy(() => import("@/pages/ops/recovery"));
const OpsSecurity     = lazy(() => import("@/pages/ops/security"));
const OpsAssistant    = lazy(() => import("@/pages/ops/assistant"));
const OpsRelease      = lazy(() => import("@/pages/ops/release"));
const OpsAuthSecurity = lazy(() => import("@/pages/ops/auth"));
const OpsStorage      = lazy(() => import("@/pages/ops/storage"));

// ── Lazy: Governance (admin-only) — own chunk ─────────────────────────────────
const GovBudgets   = lazy(() => import("@/pages/ops/governance/budgets"));
const GovUsage     = lazy(() => import("@/pages/ops/governance/usage"));
const GovAlerts    = lazy(() => import("@/pages/ops/governance/alerts"));
const GovAnomalies = lazy(() => import("@/pages/ops/governance/anomalies"));
const GovRunaway   = lazy(() => import("@/pages/ops/governance/runaway"));

// ── Loading fallback ──────────────────────────────────────────────────────────
function PageLoader() {
  return (
    <div className="flex items-center justify-center flex-1 h-full">
      <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function ProtectedApp() {
  return (
    <ProtectedRoute>
      <AppShell>
        <Suspense fallback={<PageLoader />}>
          <Switch>
            {/* Tenant core */}
            <Route path="/"              component={Dashboard} />
            <Route path="/projects"      component={Projects} />
            <Route path="/architectures" component={Architectures} />
            <Route path="/runs"          component={Runs} />
            <Route path="/runs/:id"      component={RunDetail} />

            {/* Tenant workspace surface — /tenant/* */}
            <Route path="/tenant"              component={TenantDashboard} />
            <Route path="/tenant/data"         component={TenantData} />
            <Route path="/tenant/ai"           component={TenantAI} />
            <Route path="/tenant/usage"        component={TenantUsage} />
            <Route path="/tenant/billing"      component={TenantBilling} />
            <Route path="/tenant/integrations" component={TenantIntegrations} />
            <Route path="/tenant/team"         component={TenantTeam} />
            <Route path="/tenant/settings"     component={TenantSettings} />
            <Route path="/tenant/audit"        component={TenantAudit} />

            {/* Admin platform */}
            <Route path="/integrations"      component={() => <AdminRoute><Integrations /></AdminRoute>} />
            <Route path="/settings"          component={() => <AdminRoute><Settings /></AdminRoute>} />
            <Route path="/settings/security" component={() => <AdminRoute><SecuritySettings /></AdminRoute>} />

            {/* Ops console */}
            <Route path="/ops"           component={() => <AdminRoute><OpsDashboard /></AdminRoute>} />
            <Route path="/ops/tenants"   component={() => <AdminRoute><OpsTenants /></AdminRoute>} />
            <Route path="/ops/jobs"      component={() => <AdminRoute><OpsJobs /></AdminRoute>} />
            <Route path="/ops/webhooks"  component={() => <AdminRoute><OpsWebhooks /></AdminRoute>} />
            <Route path="/ops/ai"        component={() => <AdminRoute><OpsAi /></AdminRoute>} />
            <Route path="/ops/billing"   component={() => <AdminRoute><OpsBilling /></AdminRoute>} />
            <Route path="/ops/recovery"  component={() => <AdminRoute><OpsRecovery /></AdminRoute>} />
            <Route path="/ops/security"  component={() => <AdminRoute><OpsSecurity /></AdminRoute>} />
            <Route path="/ops/assistant" component={() => <AdminRoute><OpsAssistant /></AdminRoute>} />
            <Route path="/ops/release"   component={() => <AdminRoute><OpsRelease /></AdminRoute>} />
            <Route path="/ops/auth"      component={() => <AdminRoute><OpsAuthSecurity /></AdminRoute>} />
            <Route path="/ops/storage"   component={() => <AdminRoute><OpsStorage /></AdminRoute>} />

            {/* Governance (admin-only) */}
            <Route path="/ops/governance/budgets"   component={() => <AdminRoute><GovBudgets /></AdminRoute>} />
            <Route path="/ops/governance/usage"     component={() => <AdminRoute><GovUsage /></AdminRoute>} />
            <Route path="/ops/governance/alerts"    component={() => <AdminRoute><GovAlerts /></AdminRoute>} />
            <Route path="/ops/governance/anomalies" component={() => <AdminRoute><GovAnomalies /></AdminRoute>} />
            <Route path="/ops/governance/runaway"   component={() => <AdminRoute><GovRunaway /></AdminRoute>} />

            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </AppShell>
    </ProtectedRoute>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/auth/login"                   component={AuthLogin} />
      <Route path="/auth/password-reset"          component={AuthPasswordResetRequest} />
      <Route path="/auth/password-reset-confirm"  component={AuthPasswordResetConfirm} />
      <Route path="/auth/email-verify"            component={AuthEmailVerify} />
      <Route path="/auth/invite-accept"           component={AuthInviteAccept} />
      <Route path="/auth/callback"                component={AuthCallback} />
      <Route path="/auth/mfa-challenge"           component={AuthMfaChallenge} />
      <Route component={ProtectedApp} />
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
