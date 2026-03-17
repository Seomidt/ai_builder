import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ShieldAlert, Shield, AlertTriangle, Activity, Lock, CheckCircle2,
  XCircle, AlertCircle, Cloud, Key, Server, Zap, Eye, RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { OpsNav } from "@/components/ops/OpsNav";

// ── Types ────────────────────────────────────────────────────────────────────

interface Overview {
  posture: {
    status: "pass" | "warn" | "fail";
    passing: number;
    warnings: number;
    failing: number;
    coveragePercent: number;
  };
  incidentStatus: {
    readyForIncident: boolean;
    alertingEnabled: boolean;
    auditLogsEnabled: boolean;
    backupConfigured: boolean;
    mfaAvailable: boolean;
    secretRedaction: boolean;
    rateLimitsActive: boolean;
    securityHeaders: boolean;
    notes: string[];
  };
  edgeReadiness: {
    wafReady: boolean;
    botProtectionReady: boolean;
    rateLimitReady: boolean;
    strictTlsReady: boolean;
    corsReady: boolean;
    r2Connected: boolean;
    tokenConfigured: boolean;
    overallReady: boolean;
    notes: string[];
  };
  rateLimitStats: {
    activeKeys: number;
    policies: { name: string; type: string; maxRequests: number; windowMs: number }[];
    circuitBreakers: { id: string; status: string; failureCount: number }[];
  };
  retrievedAt: string;
}

interface AuthHealth {
  failedLogins24h: number | null;
  activeSessions: number | null;
  mfaEnabled: number | null;
  mfaTotal: number | null;
  retrievedAt: string;
}

interface RateLimits {
  engineStats: { activeKeys: number };
  routeGroups: {
    group: string;
    maxRequests: number;
    windowSec: number;
    keyStrategy: string;
    description: string;
  }[];
  retrievedAt: string;
}

interface Checklist {
  totalChecks: number;
  passing: number;
  warnings: number;
  failing: number;
  overallStatus: "pass" | "warn" | "fail";
  checks: {
    id: string;
    name: string;
    description: string;
    status: "pass" | "warn" | "fail" | "unknown";
    detail?: string;
    soc2Control: string;
  }[];
  generatedAt: string;
}

interface SecurityEvents {
  events: {
    id: string;
    event_type?: string;
    eventType?: string;
    tenant_id?: string;
    actor_id?: string;
    ip?: string;
    severity?: string;
    created_at: string;
  }[];
  windowHours: number;
  total: number;
  retrievedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function postureColor(status: "pass" | "warn" | "fail" | undefined) {
  if (status === "pass") return "bg-green-500/5 border-green-500/25 text-green-400";
  if (status === "warn") return "bg-yellow-500/5 border-yellow-500/25 text-yellow-400";
  if (status === "fail") return "bg-destructive/5 border-destructive/25 text-destructive";
  return "bg-card border-card-border text-muted-foreground";
}

function postureIcon(status: "pass" | "warn" | "fail" | undefined) {
  if (status === "pass") return <Shield className="w-5 h-5 text-green-400 shrink-0" />;
  if (status === "warn") return <AlertCircle className="w-5 h-5 text-yellow-400 shrink-0" />;
  return <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />;
}

function checkIcon(status: "pass" | "warn" | "fail" | "unknown") {
  if (status === "pass") return <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />;
  if (status === "warn") return <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />;
  if (status === "fail") return <XCircle className="w-4 h-4 text-destructive shrink-0" />;
  return <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0" />;
}

function boolIcon(v: boolean) {
  return v
    ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
    : <XCircle className="w-4 h-4 text-muted-foreground shrink-0" />;
}

function statusBadge(status: "pass" | "warn" | "fail" | "unknown") {
  const styles = {
    pass:    "bg-green-500/10 text-green-400 border-green-500/25",
    warn:    "bg-yellow-500/10 text-yellow-400 border-yellow-500/25",
    fail:    "bg-destructive/10 text-destructive border-destructive/25",
    unknown: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={`text-xs ${styles[status]}`}>
      {status.toUpperCase()}
    </Badge>
  );
}

// ── MetricCard ────────────────────────────────────────────────────────────────

function MetricCard({ label, value, icon: Icon, testId, sub }: {
  label: string;
  value: string | number | null;
  icon: React.ElementType;
  testId: string;
  sub?: string;
}) {
  return (
    <Card className="bg-card border-card-border" data-testid={testId}>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center gap-2 mb-1">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <p className="text-2xl font-bold text-foreground">{value ?? "—"}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OpsSecurity() {
  const [windowHours, setWindowHours] = useState(24);

  const { data: overview,    isLoading: ovLoading    } = useQuery<Overview>({
    queryKey: ["/api/admin/security/overview"],
    refetchInterval: 60_000,
  });
  const { data: authHealth,  isLoading: authLoading  } = useQuery<AuthHealth>({
    queryKey: ["/api/admin/security/auth-health"],
    refetchInterval: 30_000,
  });
  const { data: rateLimits,  isLoading: rlLoading    } = useQuery<RateLimits>({
    queryKey: ["/api/admin/security/rate-limits"],
  });
  const { data: checklist,   isLoading: clLoading    } = useQuery<Checklist>({
    queryKey: ["/api/admin/security/checklist"],
  });
  const { data: events,      isLoading: evLoading    } = useQuery<SecurityEvents>({
    queryKey: ["/api/admin/security/events", windowHours],
    refetchInterval: 30_000,
  });

  const posture  = overview?.posture;
  const incident = overview?.incidentStatus;
  const edge     = overview?.edgeReadiness;
  const mfaPct   = authHealth?.mfaTotal
    ? Math.round(((authHealth.mfaEnabled ?? 0) / authHealth.mfaTotal) * 100)
    : null;

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-destructive" /> Security &amp; SOC2 Readiness
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Security posture, controls coverage, incidents, and edge readiness
            </p>
          </div>
          <div className="flex items-center gap-2">
            {[6, 24, 72].map(h => (
              <Button
                key={h}
                size="sm"
                variant={windowHours === h ? "default" : "outline"}
                onClick={() => setWindowHours(h)}
                data-testid={`btn-window-${h}h`}
                className="text-xs"
              >
                {h}h
              </Button>
            ))}
          </div>
        </div>

        {/* Posture Banner */}
        {ovLoading ? (
          <Skeleton className="h-14" />
        ) : (
          <Card
            className={`border ${postureColor(posture?.status)}`}
            data-testid="security-posture-banner"
          >
            <CardContent className="py-3 px-4 flex items-center gap-3">
              {postureIcon(posture?.status)}
              <div className="flex-1">
                <p className="text-sm font-medium">
                  Security posture:{" "}
                  <strong className="capitalize">{posture?.status ?? "unknown"}</strong>
                  {" — "}{posture?.passing ?? 0} passing,{" "}
                  {posture?.warnings ?? 0} warnings,{" "}
                  {posture?.failing ?? 0} failing
                </p>
              </div>
              <Badge variant="outline" className="text-xs font-mono shrink-0">
                {posture?.coveragePercent ?? 0}% covered
              </Badge>
              {overview?.retrievedAt && (
                <span className="text-xs text-muted-foreground shrink-0">
                  <RefreshCw className="w-3 h-3 inline mr-1" />
                  {new Date(overview.retrievedAt).toLocaleTimeString()}
                </span>
              )}
            </CardContent>
          </Card>
        )}

        {/* Auth Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {authLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <MetricCard
                label="Failed Logins (24h)"
                value={authHealth?.failedLogins24h ?? null}
                icon={Lock}
                testId="card-failed-logins"
              />
              <MetricCard
                label="Active Sessions"
                value={authHealth?.activeSessions ?? null}
                icon={Activity}
                testId="card-active-sessions"
              />
              <MetricCard
                label="MFA Enabled"
                value={authHealth?.mfaEnabled ?? null}
                icon={Shield}
                testId="card-mfa-enabled"
                sub={mfaPct !== null ? `${mfaPct}% adoption` : undefined}
              />
              <MetricCard
                label="Rate Limit Buckets"
                value={overview?.rateLimitStats?.activeKeys ?? null}
                icon={Zap}
                testId="card-rl-buckets"
                sub="active tracking keys"
              />
            </>
          )}
        </div>

        {/* Incident Readiness + Edge Readiness */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Incident Readiness */}
          <Card className="bg-card border-card-border" data-testid="incident-readiness-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Server className="w-4 h-4 text-muted-foreground" /> Incident Readiness
              </CardTitle>
            </CardHeader>
            <CardContent>
              {ovLoading ? (
                <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
              ) : (
                <div className="space-y-2">
                  {[
                    { label: "Audit Logs Active",     ok: incident?.auditLogsEnabled ?? false },
                    { label: "Rate Limits Active",    ok: incident?.rateLimitsActive  ?? false },
                    { label: "MFA Available",         ok: incident?.mfaAvailable      ?? false },
                    { label: "Secret Redaction",      ok: incident?.secretRedaction   ?? false },
                    { label: "Security Headers",      ok: incident?.securityHeaders   ?? false },
                    { label: "Backup Configured",     ok: incident?.backupConfigured  ?? false },
                    { label: "Alerting Enabled",      ok: incident?.alertingEnabled   ?? false },
                  ].map(({ label, ok }) => (
                    <div key={label} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">
                        {boolIcon(ok)}
                        <span className="text-xs text-muted-foreground">{label}</span>
                      </div>
                      {ok
                        ? <Badge variant="outline" className="text-xs bg-green-500/10 text-green-400 border-green-500/25">Active</Badge>
                        : <Badge variant="outline" className="text-xs bg-yellow-500/10 text-yellow-400 border-yellow-500/25">Missing</Badge>
                      }
                    </div>
                  ))}
                  {incident?.readyForIncident && (
                    <p className="text-xs text-green-400 mt-2 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Ready for incident response
                    </p>
                  )}
                  {incident?.notes && incident.notes.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {incident.notes.map((n, i) => (
                        <p key={i} className="text-xs text-yellow-400/80 flex items-start gap-1">
                          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /> {n}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Edge Readiness */}
          <Card className="bg-card border-card-border" data-testid="edge-readiness-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Cloud className="w-4 h-4 text-muted-foreground" /> Cloudflare Edge Readiness
              </CardTitle>
            </CardHeader>
            <CardContent>
              {ovLoading ? (
                <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
              ) : (
                <div className="space-y-2">
                  {[
                    { label: "CF Token Configured",  ok: edge?.tokenConfigured    ?? false },
                    { label: "R2 Connected",          ok: edge?.r2Connected        ?? false },
                    { label: "WAF Ready",             ok: edge?.wafReady           ?? false },
                    { label: "Bot Protection Ready",  ok: edge?.botProtectionReady ?? false },
                    { label: "Rate Limit Ready",      ok: edge?.rateLimitReady     ?? false },
                    { label: "Strict TLS Ready",      ok: edge?.strictTlsReady     ?? false },
                    { label: "CORS Ready",            ok: edge?.corsReady          ?? false },
                  ].map(({ label, ok }) => (
                    <div key={label} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">
                        {boolIcon(ok)}
                        <span className="text-xs text-muted-foreground">{label}</span>
                      </div>
                      {ok
                        ? <Badge variant="outline" className="text-xs bg-green-500/10 text-green-400 border-green-500/25">Ready</Badge>
                        : <Badge variant="outline" className="text-xs bg-muted text-muted-foreground border-border">Pending</Badge>
                      }
                    </div>
                  ))}
                  {edge?.overallReady && (
                    <p className="text-xs text-green-400 mt-2 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Edge protection can be safely enabled
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* SOC2 Readiness Checklist */}
        <Card className="bg-card border-card-border" data-testid="soc2-checklist-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Key className="w-4 h-4 text-muted-foreground" /> SOC2 Readiness Checklist
              {!clLoading && checklist && (
                <div className="ml-auto flex items-center gap-2">
                  {statusBadge(checklist.overallStatus)}
                  <span className="text-xs text-muted-foreground font-normal">
                    {checklist.passing}/{checklist.totalChecks} passing
                  </span>
                </div>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {clLoading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : (
              <div className="divide-y divide-border">
                {checklist?.checks.map(c => (
                  <div
                    key={c.id}
                    className="flex items-start gap-3 px-4 py-3"
                    data-testid={`soc2-check-${c.id}`}
                  >
                    {checkIcon(c.status)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-medium text-foreground">{c.name}</p>
                        <Badge variant="outline" className="text-xs font-mono text-muted-foreground border-border shrink-0">
                          {c.soc2Control}
                        </Badge>
                      </div>
                      {c.detail && <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.detail}</p>}
                    </div>
                    {statusBadge(c.status)}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Rate Limit Policies */}
        <Card className="bg-card border-card-border" data-testid="rate-limit-policies-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Zap className="w-4 h-4 text-muted-foreground" /> Route-Group Rate Limit Policies
              {!rlLoading && rateLimits && (
                <span className="ml-auto text-xs text-muted-foreground font-normal">
                  {rateLimits.routeGroups.length} groups · {rateLimits.engineStats.activeKeys} active keys
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {rlLoading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
            ) : (
              <div className="divide-y divide-border">
                {rateLimits?.routeGroups.map(g => (
                  <div
                    key={g.group}
                    className="flex items-center gap-3 px-4 py-2.5"
                    data-testid={`rl-group-${g.group}`}
                  >
                    <span className="text-xs font-mono text-foreground w-40 shrink-0">{g.group}</span>
                    <span className="text-xs text-muted-foreground flex-1 truncate">{g.description}</span>
                    <Badge variant="outline" className="text-xs font-mono border-border text-muted-foreground shrink-0">
                      {g.maxRequests}/{g.windowSec}s
                    </Badge>
                    <Badge variant="outline" className="text-xs border-border text-muted-foreground shrink-0">
                      {g.keyStrategy}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Security Events Feed */}
        <Card className="bg-card border-card-border" data-testid="security-events-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Eye className="w-4 h-4 text-muted-foreground" /> Security Events Feed
              {!evLoading && events && (
                <span className="ml-auto text-xs text-muted-foreground font-normal">
                  {events.total} events in last {windowHours}h
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {evLoading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : events && events.events.length > 0 ? (
              <div className="divide-y divide-border" data-testid="security-events-list">
                {events.events.slice(0, 50).map(e => {
                  const type     = e.event_type ?? e.eventType ?? "unknown";
                  const severity = e.severity;
                  return (
                    <div
                      key={e.id}
                      className="flex items-center gap-3 px-4 py-2.5"
                      data-testid={`security-event-${e.id}`}
                    >
                      <span className="text-xs font-mono text-foreground w-40 shrink-0 truncate">{type}</span>
                      <div className="flex-1 flex items-center gap-2 min-w-0">
                        {e.tenant_id && (
                          <span className="text-xs text-muted-foreground font-mono truncate max-w-[120px]">{e.tenant_id}</span>
                        )}
                        {e.ip && (
                          <span className="text-xs text-muted-foreground font-mono">{e.ip}</span>
                        )}
                      </div>
                      {severity && (
                        <Badge
                          variant="outline"
                          className={`text-xs shrink-0 ${
                            severity === "critical" ? "bg-destructive/10 text-destructive border-destructive/25" :
                            severity === "warning"  ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/25" :
                            "border-border text-muted-foreground"
                          }`}
                        >
                          {severity}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">
                        {new Date(e.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-8 text-center">
                <Shield className="w-8 h-8 text-green-400/50 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="no-security-events-msg">
                  No security events in the last {windowHours}h
                </p>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
