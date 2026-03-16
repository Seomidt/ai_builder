import { useQuery } from "@tanstack/react-query";
import { OpsNav } from "@/components/ops/OpsNav";
import { MetricCard } from "@/components/ops/MetricCard";
import { StatusPill } from "@/components/ops/StatusPill";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertTriangle, Shield, Users, Key } from "lucide-react";
import { useState } from "react";

interface AuthOverview {
  failures24h:       number;
  logins24h:         number;
  failures7d:        number;
  activeSessions:    number;
  revokedSessions:   number;
  mfaEnabled:        number;
  totalWithMfa:      number;
  securityEvents24h: number;
  retrievedAt:       string;
}

interface SuspiciousEvent {
  id:            string;
  tenant_id:     string | null;
  user_id:       string | null;
  event_type:    string;
  severity:      string;
  ip_address:    string | null;
  metadata_json: any;
  created_at:    string;
}

interface LoginFailure {
  email_hash:     string;
  ip_address:     string | null;
  failure_reason: string | null;
  attempts:       number;
  last_attempt:   string;
}

interface MfaAdoption {
  totalEnrolled:       number;
  enabled:             number;
  pendingVerification: number;
  adoptionPct:         number;
}

function severityColor(sev: string) {
  if (sev === "critical") return "text-red-400";
  if (sev === "warning")  return "text-yellow-400";
  return "text-muted-foreground";
}

export default function OpsAuth() {
  const [windowHours, setWindowHours] = useState(24);

  const overview = useQuery<AuthOverview>({
    queryKey: ["/api/admin/auth/overview"],
    refetchInterval: 60_000,
  });

  const suspicious = useQuery<{ events: SuspiciousEvent[] }>({
    queryKey: ["/api/admin/auth/suspicious-events", windowHours],
    refetchInterval: 60_000,
  });

  const failures = useQuery<{ failures: LoginFailure[] }>({
    queryKey: ["/api/admin/auth/login-failures", windowHours],
    refetchInterval: 60_000,
  });

  const mfa = useQuery<MfaAdoption>({
    queryKey: ["/api/admin/auth/mfa-adoption"],
    refetchInterval: 120_000,
  });

  const refetchAll = () => {
    overview.refetch();
    suspicious.refetch();
    failures.refetch();
    mfa.refetch();
  };

  const d = overview.data;

  return (
    <div className="min-h-screen bg-background" data-testid="ops-auth-page">
      <OpsNav />
      <div className="px-6 py-6 space-y-6 max-w-[1400px] mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Auth Security</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Login attempts, sessions, MFA and security events</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="text-sm bg-card border border-border rounded px-2 py-1.5"
              value={windowHours}
              onChange={e => setWindowHours(Number(e.target.value))}
              data-testid="select-window-hours"
            >
              <option value={6}>Last 6h</option>
              <option value={24}>Last 24h</option>
              <option value={72}>Last 72h</option>
              <option value={168}>Last 7d</option>
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={refetchAll}
              disabled={overview.isFetching}
              data-testid="btn-refresh-auth"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${overview.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {overview.isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)
          ) : (
            <>
              <MetricCard
                title="Login Failures (24h)"
                value={String(d?.failures24h ?? 0)}
                icon={<AlertTriangle className="w-4 h-4" />}
                testId="metric-failures-24h"
              />
              <MetricCard
                title="Successful Logins (24h)"
                value={String(d?.logins24h ?? 0)}
                icon={<Users className="w-4 h-4" />}
                testId="metric-logins-24h"
              />
              <MetricCard
                title="Active Sessions"
                value={String(d?.activeSessions ?? 0)}
                icon={<Shield className="w-4 h-4" />}
                testId="metric-active-sessions"
              />
              <MetricCard
                title="MFA Enabled"
                value={`${d?.mfaEnabled ?? 0} users`}
                icon={<Key className="w-4 h-4" />}
                testId="metric-mfa-enabled"
              />
            </>
          )}
        </div>

        {/* Status pills */}
        {d && (
          <div className="flex flex-wrap gap-3" data-testid="auth-status-pills">
            <StatusPill
              label={`Failure rate: ${d.logins24h + d.failures24h > 0 ? Math.round(d.failures24h / (d.logins24h + d.failures24h) * 100) : 0}%`}
              variant={d.failures24h > 50 ? "destructive" : d.failures24h > 10 ? "warning" : "success"}
              testId="pill-failure-rate"
            />
            <StatusPill
              label={`MFA adoption: ${mfa.data?.adoptionPct ?? 0}%`}
              variant={mfa.data ? (mfa.data.adoptionPct > 70 ? "success" : mfa.data.adoptionPct > 30 ? "warning" : "destructive") : "warning"}
              testId="pill-mfa-adoption"
            />
            <StatusPill
              label={`${d.securityEvents24h} security events (24h)`}
              variant={d.securityEvents24h > 20 ? "destructive" : d.securityEvents24h > 5 ? "warning" : "success"}
              testId="pill-security-events"
            />
          </div>
        )}

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Suspicious events */}
          <Card data-testid="suspicious-events-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400" />
                Suspicious / Warning Events
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              {suspicious.isLoading ? (
                Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full mb-1" />)
              ) : (suspicious.data?.events ?? []).length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground" data-testid="no-suspicious-events">
                  No suspicious events in this window.
                </p>
              ) : (
                (suspicious.data?.events ?? []).slice(0, 10).map((e, i) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between px-4 py-2 border-b border-border last:border-0 gap-2"
                    data-testid={`suspicious-event-row-${i}`}
                  >
                    <div className="min-w-0">
                      <p className={`text-xs font-medium ${severityColor(e.severity)}`}>{e.event_type}</p>
                      <p className="text-xs text-muted-foreground truncate">{e.ip_address ?? "—"} · {new Date(e.created_at).toLocaleTimeString()}</p>
                    </div>
                    <span className={`text-xs font-medium shrink-0 ${severityColor(e.severity)}`}>{e.severity}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Login failures */}
          <Card data-testid="login-failures-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Top Login Failures</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              {failures.isLoading ? (
                Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full mb-1" />)
              ) : (failures.data?.failures ?? []).length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground" data-testid="no-failures-msg">
                  No login failures in this window.
                </p>
              ) : (
                (failures.data?.failures ?? []).slice(0, 10).map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-4 py-2 border-b border-border last:border-0"
                    data-testid={`failure-row-${i}`}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-muted-foreground truncate">{f.email_hash.slice(0, 16)}…</p>
                      <p className="text-xs text-muted-foreground">{f.ip_address ?? "—"} · {f.failure_reason ?? "unknown"}</p>
                    </div>
                    <span className="text-xs font-medium text-red-400 shrink-0" data-testid={`failure-count-${i}`}>
                      {f.attempts}×
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* MFA Adoption */}
        {mfa.data && (
          <Card data-testid="mfa-adoption-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Key className="w-4 h-4" /> MFA Adoption
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-6 py-2">
              <div data-testid="mfa-total-enrolled">
                <p className="text-2xl font-bold">{mfa.data.totalEnrolled}</p>
                <p className="text-xs text-muted-foreground">Total enrolled</p>
              </div>
              <div data-testid="mfa-enabled-count">
                <p className="text-2xl font-bold text-green-400">{mfa.data.enabled}</p>
                <p className="text-xs text-muted-foreground">Active MFA</p>
              </div>
              <div data-testid="mfa-pending-count">
                <p className="text-2xl font-bold text-yellow-400">{mfa.data.pendingVerification}</p>
                <p className="text-xs text-muted-foreground">Pending verification</p>
              </div>
              <div data-testid="mfa-adoption-pct">
                <p className="text-2xl font-bold">{mfa.data.adoptionPct}%</p>
                <p className="text-xs text-muted-foreground">Adoption rate</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
