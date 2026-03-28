/**
 * TenantApp — AI Experts Platform — Tenant Product Surface
 *
 * Rendered exclusively on app.blissops.com (and localhost in dev).
 *
 * Navigation:
 *   Oversigt · AI Eksperter · Viden & Data · Regler · Kørseler · Team · Workspace
 *
 * SECURITY:
 *   - Admin routes (/ops/*, /integrations) are NOT registered here
 *   - Backend enforces platform_admin and tenant-scoped RBAC on all routes
 *   - Domain routing is UI convenience only — no auth trust from hostname
 */

import { lazy, Suspense, useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { TenantSidebar } from "@/components/layout/TenantSidebar";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import NotFound from "@/pages/not-found";

// ── Eagerly loaded: core tenant product pages ──────────────────────────────────
import AiEksperter from "@/pages/ai-eksperter";
import VidenData   from "@/pages/viden-data";
import Regler      from "@/pages/regler";
import Runs        from "@/pages/runs";
import Team        from "@/pages/team";

// ── Lazy: detail pages ────────────────────────────────────────────────────────
const RunDetail       = lazy(() => import("@/pages/run-detail"));
const AiEkspertDetail  = lazy(() => import("@/pages/ai-ekspert-detail"));
const AiEkspertEditor  = lazy(() => import("@/pages/ai-ekspert-editor"));
const StorageDetail   = lazy(() => import("@/pages/storage-detail"));

// ── Lazy: Insights ────────────────────────────────────────────────────────────
const InsightsPage = lazy(() => import("@/pages/tenant/insights"));

// ── Lazy: workspace surface ───────────────────────────────────────────────────
const WorkspaceDashboard    = lazy(() => import("@/pages/tenant/dashboard"));
const WorkspaceData         = lazy(() => import("@/pages/tenant/data"));
const WorkspaceAI           = lazy(() => import("@/pages/tenant/ai"));
const WorkspaceUsage        = lazy(() => import("@/pages/tenant/usage"));
const WorkspaceBilling      = lazy(() => import("@/pages/tenant/billing"));
const WorkspaceIntegrations = lazy(() => import("@/pages/tenant/integrations"));
const WorkspaceSettings     = lazy(() => import("@/pages/tenant/settings"));
const WorkspaceAudit        = lazy(() => import("@/pages/tenant/audit"));

// ── Lazy: AI Chat ─────────────────────────────────────────────────────────────
const AiChat = lazy(() => import("@/pages/ai-chat"));

// ── Lazy: Dashboard (still accessible, not default) ───────────────────────────
const Dashboard = lazy(() => import("@/pages/dashboard"));

// ── Lazy: onboarding ─────────────────────────────────────────────────────────
const Onboarding = lazy(() => import("@/pages/onboarding"));

// ── Redirect helper ───────────────────────────────────────────────────────────
function Redirect({ to }: { to: string }) {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation(to); }, []);
  return null;
}

function TenantLoader() {
  return (
    <div className="flex items-center justify-center flex-1 h-full">
      <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function TenantShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <TenantSidebar />
      <main className="flex-1 min-h-0 overflow-y-auto pt-14 lg:pt-0">{children}</main>
    </div>
  );
}

export function TenantApp() {
  return (
    <ProtectedRoute>
      <TenantShell>
        <Suspense fallback={<TenantLoader />}>
          <Switch>
            {/* ── Default: redirect root to AI Chat ───────────────────── */}
            <Route path="/">
              <Redirect to="/ai-chat" />
            </Route>
            <Route path="/ai-eksperter" component={AiEksperter} />
            <Route path="/ai-eksperter/opret" component={AiEkspertEditor} />
            <Route path="/ai-eksperter/:id/rediger" component={AiEkspertEditor} />
            <Route path="/ai-eksperter/:id" component={AiEkspertDetail} />
            <Route path="/viden-data"      component={VidenData} />
            <Route path="/viden-data/:id"  component={StorageDetail} />
            <Route path="/regler"          component={Regler} />
            <Route path="/koerseler"    component={Runs} />
            <Route path="/koerseler/:id" component={RunDetail} />
            <Route path="/team"         component={Team} />

            {/* ── AI Chat ──────────────────────────────────────────────── */}
            <Route path="/ai-chat"      component={AiChat} />

            {/* ── Direct top-level shortcuts for nav items ─────────────── */}
            <Route path="/insights"      component={InsightsPage} />
            <Route path="/brug"         component={WorkspaceUsage} />
            <Route path="/indstillinger" component={WorkspaceSettings} />

            {/* ── Workspace surface (/workspace/*) ─────────────────────── */}
            <Route path="/workspace"              component={WorkspaceDashboard} />
            <Route path="/workspace/data"         component={WorkspaceData} />
            <Route path="/workspace/ai"           component={WorkspaceAI} />
            <Route path="/workspace/usage"        component={WorkspaceUsage} />
            <Route path="/workspace/billing"      component={WorkspaceBilling} />
            <Route path="/workspace/integrations" component={WorkspaceIntegrations} />
            <Route path="/workspace/settings"     component={WorkspaceSettings} />
            <Route path="/workspace/audit"        component={WorkspaceAudit} />

            {/* ── Onboarding ───────────────────────────────────────────── */}
            <Route path="/onboarding" component={Onboarding} />

            {/* ── Backward-compat redirects ────────────────────────────── */}
            <Route path="/architectures">
              <Redirect to="/ai-eksperter" />
            </Route>
            <Route path="/projects">
              <Redirect to="/viden-data" />
            </Route>
            <Route path="/runs">
              <Redirect to="/koerseler" />
            </Route>
            <Route path="/tenant/team">
              <Redirect to="/team" />
            </Route>
            <Route path="/tenant">
              <Redirect to="/workspace" />
            </Route>
            <Route path="/tenant/data">
              <Redirect to="/workspace/data" />
            </Route>
            <Route path="/tenant/ai">
              <Redirect to="/workspace/ai" />
            </Route>
            <Route path="/tenant/usage">
              <Redirect to="/workspace/usage" />
            </Route>
            <Route path="/tenant/billing">
              <Redirect to="/workspace/billing" />
            </Route>
            <Route path="/tenant/integrations">
              <Redirect to="/workspace/integrations" />
            </Route>
            <Route path="/tenant/settings">
              <Redirect to="/workspace/settings" />
            </Route>
            <Route path="/tenant/audit">
              <Redirect to="/workspace/audit" />
            </Route>

            {/* Admin/ops routes on tenant domain → not registered → 404 */}
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </TenantShell>
    </ProtectedRoute>
  );
}
