/**
 * AdminApp — Platform Operations Surface
 *
 * Rendered exclusively on admin.blissops.com (and admin.localhost in dev).
 *
 * Contains:
 *   - AdminSidebar (ops + governance + admin nav)
 *   - All /ops/* routes
 *   - /integrations + /settings routes
 *   - ALL routes wrapped with AdminRoute (backend-verified platform_admin)
 *
 * SECURITY:
 *   - Domain is UI routing ONLY — no auth trust from hostname
 *   - AdminRoute still validates role via /api/auth/session backend response
 *   - Non-platform_admin users see OpsAccessDenied on every route
 */

import { lazy, Suspense } from "react";
import { Switch, Route } from "wouter";
import { AdminSidebar } from "@/components/layout/AdminSidebar";
import { AdminRoute } from "@/components/auth/AdminRoute";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";

// ── Ops console ────────────────────────────────────────────────────────────────
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
const OpsAiCosts      = lazy(() => import("@/pages/ops/ai-costs"));

// ── Admin platform ─────────────────────────────────────────────────────────────
const Integrations     = lazy(() => import("@/pages/integrations"));
const Settings         = lazy(() => import("@/pages/settings"));
const SecuritySettings = lazy(() => import("@/pages/settings/security"));

// ── Governance ─────────────────────────────────────────────────────────────────
const GovBudgets   = lazy(() => import("@/pages/ops/governance/budgets"));
const GovUsage     = lazy(() => import("@/pages/ops/governance/usage"));
const GovAlerts    = lazy(() => import("@/pages/ops/governance/alerts"));
const GovAnomalies = lazy(() => import("@/pages/ops/governance/anomalies"));
const GovRunaway   = lazy(() => import("@/pages/ops/governance/runaway"));

function AdminLoader() {
  return (
    <div className="flex items-center justify-center flex-1 h-full">
      <div className="h-6 w-6 rounded-full border-2 border-destructive border-t-transparent animate-spin" />
    </div>
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AdminSidebar />
      <main className="flex-1 overflow-y-auto pt-14 lg:pt-0">{children}</main>
    </div>
  );
}

function wrap(Component: React.ComponentType) {
  return () => (
    <AdminRoute>
      <Component />
    </AdminRoute>
  );
}

export function AdminApp() {
  return (
    <ProtectedRoute>
      <AdminShell>
        <Suspense fallback={<AdminLoader />}>
          <Switch>
            {/* Redirect root → ops console */}
            <Route path="/"              component={wrap(OpsDashboard)} />

            {/* Ops console */}
            <Route path="/ops"           component={wrap(OpsDashboard)} />
            <Route path="/ops/tenants"   component={wrap(OpsTenants)} />
            <Route path="/ops/jobs"      component={wrap(OpsJobs)} />
            <Route path="/ops/webhooks"  component={wrap(OpsWebhooks)} />
            <Route path="/ops/ai"        component={wrap(OpsAi)} />
            <Route path="/ops/billing"   component={wrap(OpsBilling)} />
            <Route path="/ops/recovery"  component={wrap(OpsRecovery)} />
            <Route path="/ops/security"  component={wrap(OpsSecurity)} />
            <Route path="/ops/assistant" component={wrap(OpsAssistant)} />
            <Route path="/ops/release"   component={wrap(OpsRelease)} />
            <Route path="/ops/auth"      component={wrap(OpsAuthSecurity)} />
            <Route path="/ops/storage"   component={wrap(OpsStorage)} />
            <Route path="/ops/ai-costs" component={wrap(OpsAiCosts)} />

            {/* Admin platform */}
            <Route path="/integrations"      component={wrap(Integrations)} />
            <Route path="/settings"          component={wrap(Settings)} />
            <Route path="/settings/security" component={wrap(SecuritySettings)} />

            {/* Governance */}
            <Route path="/ops/governance/budgets"   component={wrap(GovBudgets)} />
            <Route path="/ops/governance/usage"     component={wrap(GovUsage)} />
            <Route path="/ops/governance/alerts"    component={wrap(GovAlerts)} />
            <Route path="/ops/governance/anomalies" component={wrap(GovAnomalies)} />
            <Route path="/ops/governance/runaway"   component={wrap(GovRunaway)} />

            {/* Fallback — non-admin routes blocked on admin domain */}
            <Route>
              {() => (
                <AdminRoute>
                  <OpsDashboard />
                </AdminRoute>
              )}
            </Route>
          </Switch>
        </Suspense>
      </AdminShell>
    </ProtectedRoute>
  );
}
