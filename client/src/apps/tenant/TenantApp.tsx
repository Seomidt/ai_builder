/**
 * TenantApp — Tenant Product Surface
 *
 * Rendered exclusively on app.blissops.com (and localhost in dev).
 *
 * Contains:
 *   - TenantSidebar (tenant-only nav — ZERO admin links)
 *   - All tenant routes (/, /projects, /architectures, /runs, /tenant/*)
 *   - All routes wrapped with ProtectedRoute (session required)
 *
 * SECURITY:
 *   - Admin routes (/ops/*, /integrations, /settings) are NOT registered here
 *   - If a user navigates to /ops on app domain → 404 (NotFound)
 *   - Backend still enforces platform_admin on all /api/admin/* routes
 *   - Domain is UI routing ONLY — no auth trust from hostname
 */

import { lazy, Suspense } from "react";
import { Switch, Route } from "wouter";
import { TenantSidebar } from "@/components/layout/TenantSidebar";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import NotFound from "@/pages/not-found";

// ── Eagerly loaded: core tenant pages ─────────────────────────────────────────
import Dashboard     from "@/pages/dashboard";
import Projects      from "@/pages/projects";
import Architectures from "@/pages/architectures";
import Runs          from "@/pages/runs";

// ── Lazy: tenant detail ───────────────────────────────────────────────────────
const RunDetail = lazy(() => import("@/pages/run-detail"));

// ── Lazy: tenant workspace surface ────────────────────────────────────────────
const TenantDashboard    = lazy(() => import("@/pages/tenant/dashboard"));
const TenantData         = lazy(() => import("@/pages/tenant/data"));
const TenantAI           = lazy(() => import("@/pages/tenant/ai"));
const TenantUsage        = lazy(() => import("@/pages/tenant/usage"));
const TenantBilling      = lazy(() => import("@/pages/tenant/billing"));
const TenantIntegrations = lazy(() => import("@/pages/tenant/integrations"));
const TenantTeam         = lazy(() => import("@/pages/tenant/team"));
const TenantSettings     = lazy(() => import("@/pages/tenant/settings"));
const TenantAudit        = lazy(() => import("@/pages/tenant/audit"));

function TenantLoader() {
  return (
    <div className="flex items-center justify-center flex-1 h-full">
      <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function TenantShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <TenantSidebar />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

export function TenantApp() {
  return (
    <ProtectedRoute>
      <TenantShell>
        <Suspense fallback={<TenantLoader />}>
          <Switch>
            {/* Core tenant */}
            <Route path="/"              component={Dashboard} />
            <Route path="/projects"      component={Projects} />
            <Route path="/architectures" component={Architectures} />
            <Route path="/runs"          component={Runs} />
            <Route path="/runs/:id"      component={RunDetail} />

            {/* Tenant workspace surface */}
            <Route path="/tenant"              component={TenantDashboard} />
            <Route path="/tenant/data"         component={TenantData} />
            <Route path="/tenant/ai"           component={TenantAI} />
            <Route path="/tenant/usage"        component={TenantUsage} />
            <Route path="/tenant/billing"      component={TenantBilling} />
            <Route path="/tenant/integrations" component={TenantIntegrations} />
            <Route path="/tenant/team"         component={TenantTeam} />
            <Route path="/tenant/settings"     component={TenantSettings} />
            <Route path="/tenant/audit"        component={TenantAudit} />

            {/* Admin/ops routes on tenant domain → not registered → 404 */}
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </TenantShell>
    </ProtectedRoute>
  );
}
