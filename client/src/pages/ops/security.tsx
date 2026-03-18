import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ShieldAlert, Shield, AlertTriangle, Activity, Lock, CheckCircle2,
  XCircle, AlertCircle, Cloud, Key, Server, Zap, Eye, RefreshCw,
  Webhook, Database, BellRing, Globe,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { OpsNav } from "@/components/ops/OpsNav";
import { useToast } from "@/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────────────

interface Overview {
  posture: { status: "pass" | "warn" | "fail"; passing: number; warnings: number; failing: number; coveragePercent: number };
  incidentStatus: { readyForIncident: boolean; alertingEnabled: boolean; auditLogsEnabled: boolean; backupConfigured: boolean; mfaAvailable: boolean; secretRedaction: boolean; rateLimitsActive: boolean; securityHeaders: boolean; notes: string[] };
  edgeReadiness: { wafReady: boolean; botProtectionReady: boolean; rateLimitReady: boolean; strictTlsReady: boolean; corsReady: boolean; r2Connected: boolean; tokenConfigured: boolean; overallReady: boolean; notes: string[] };
  rateLimitStats: { activeKeys: number };
  retrievedAt: string;
}
interface AuthHealth { failedLogins24h: number | null; activeSessions: number | null; mfaEnabled: number | null; mfaTotal: number | null; retrievedAt: string }
interface RateLimits { engineStats: { activeKeys: number }; routeGroups: { group: string; maxRequests: number; windowSec: number; keyStrategy: string; description: string }[]; retrievedAt: string }
interface Checklist { totalChecks: number; passing: number; warnings: number; failing: number; overallStatus: "pass" | "warn" | "fail"; checks: { id: string; name: string; description: string; status: "pass" | "warn" | "fail" | "unknown"; detail?: string; soc2Control: string }[]; generatedAt: string }
interface SecurityEvents { events: { id: string; event_type?: string; eventType?: string; tenant_id?: string; actor_id?: string; ip?: string; severity?: string; created_at: string }[]; total: number; retrievedAt: string }

interface HeadersData {
  headers: { name: string; value: string; description: string }[];
  csp: { policy: string; directiveCount: number };
  validation: { valid: boolean; missing: string[]; present: string[] };
  isProduction: boolean;
  retrievedAt: string;
}
interface BruteForceData {
  stats: { activeEntries: number; blockedEntries: number; topOffenders: { key: string; failures: number; blockedUntil: string | null }[] };
  thresholds: { attempts: number; cooldownSeconds: number; description: string }[];
  retrievedAt: string;
}
interface SessionsData {
  totalActive: number;
  totalRevokedToday: number;
  recentRevocations: { userId: string; reason: string; revokedAt: string; ip: string | null }[];
  retrievedAt: string;
}
interface WebhookData {
  total: number;
  failures: number;
  recentFailures: { provider: string; reason: string; at: string }[];
  retrievedAt: string;
}
interface BackupData {
  health: { overall: "healthy" | "warning" | "critical"; items: { name: string; status: string; detail: string }[] };
  restore: { ready: boolean; notes: string[] };
  retrievedAt: string;
}
interface AlertsData {
  alerts: { id: string; alertType: string; severity: string; message: string; emittedAt: string }[];
  unresolvedCritical: number;
  retrievedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function postureVariant(s?: "pass" | "warn" | "fail") {
  if (s === "pass") return "bg-green-500/5 border-green-500/25";
  if (s === "warn") return "bg-yellow-500/5 border-yellow-500/25";
  return "bg-destructive/5 border-destructive/25";
}
function postureIcon(s?: "pass" | "warn" | "fail") {
  if (s === "pass") return <Shield className="w-5 h-5 text-green-400 shrink-0" />;
  if (s === "warn") return <AlertCircle className="w-5 h-5 text-yellow-400 shrink-0" />;
  return <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />;
}
function checkIcon(s: "pass" | "warn" | "fail" | "unknown") {
  if (s === "pass")    return <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />;
  if (s === "warn")    return <AlertCircle  className="w-4 h-4 text-yellow-400 shrink-0" />;
  if (s === "fail")    return <XCircle      className="w-4 h-4 text-destructive shrink-0" />;
  return <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0" />;
}
function boolIcon(v: boolean) {
  return v ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" /> : <XCircle className="w-4 h-4 text-muted-foreground shrink-0" />;
}
function statusBadge(s: "pass" | "warn" | "fail" | "unknown" | "healthy" | "warning" | "critical") {
  const map: Record<string, string> = {
    pass:     "bg-green-500/10 text-green-400 border-green-500/25",
    healthy:  "bg-green-500/10 text-green-400 border-green-500/25",
    warn:     "bg-yellow-500/10 text-yellow-400 border-yellow-500/25",
    warning:  "bg-yellow-500/10 text-yellow-400 border-yellow-500/25",
    fail:     "bg-destructive/10 text-destructive border-destructive/25",
    critical: "bg-destructive/10 text-destructive border-destructive/25",
    unknown:  "bg-muted text-muted-foreground border-border",
  };
  return <Badge variant="outline" className={`text-xs ${map[s] ?? map.unknown}`}>{s.toUpperCase()}</Badge>;
}
function MetricCard({ label, value, icon: Icon, testId, sub }: { label: string; value: string | number | null; icon: React.ElementType; testId: string; sub?: string }) {
  return (
    <Card className="bg-card border-card-border" data-testid={testId}>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center gap-2 mb-1"><Icon className="w-4 h-4 text-muted-foreground" /><p className="text-xs text-muted-foreground">{label}</p></div>
        <p className="text-2xl font-bold text-foreground">{value ?? "—"}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function OpsSecurity() {
  const [windowHours, setWindowHours] = useState(24);
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: overview,   isLoading: ovL  } = useQuery<Overview>      ({ queryKey: ["/api/admin/security/overview"],             refetchInterval: 60_000 });
  const { data: authHealth, isLoading: ahL  } = useQuery<AuthHealth>    ({ queryKey: ["/api/admin/security/auth-health"],          refetchInterval: 30_000 });
  const { data: rateLimits, isLoading: rlL  } = useQuery<RateLimits>    ({ queryKey: ["/api/admin/security/rate-limits"] });
  const { data: checklist,  isLoading: clL  } = useQuery<Checklist>     ({ queryKey: ["/api/admin/security/checklist"] });
  const { data: events,     isLoading: evL  } = useQuery<SecurityEvents> ({ queryKey: ["/api/admin/security/events", windowHours],  refetchInterval: 30_000 });
  const { data: headers,    isLoading: hdL  } = useQuery<HeadersData>   ({ queryKey: ["/api/admin/security/headers"] });
  const { data: brute,      isLoading: bfL  } = useQuery<BruteForceData>({ queryKey: ["/api/admin/security/brute-force"],          refetchInterval: 30_000 });
  const { data: sessions,   isLoading: seL  } = useQuery<SessionsData>  ({ queryKey: ["/api/admin/security/sessions"],             refetchInterval: 30_000 });
  const { data: webhooks,   isLoading: whL  } = useQuery<WebhookData>   ({ queryKey: ["/api/admin/security/webhook-verification"], refetchInterval: 30_000 });
  const { data: backup,     isLoading: buL  } = useQuery<BackupData>    ({ queryKey: ["/api/admin/security/backup-health"] });
  const { data: alerts,     isLoading: alL  } = useQuery<AlertsData>    ({ queryKey: ["/api/admin/security/alerts"],               refetchInterval: 30_000 });

  const dryRunMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/security/backup-dry-run").then(r => r.json()),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/security/backup-health"] });
      toast({ title: data.success ? "Dry-run passed" : "Dry-run failed", description: `${data.checks?.filter((c: any) => c.passed).length ?? 0}/${data.checks?.length ?? 0} checks passed` });
    },
  });

  const posture  = overview?.posture;
  const incident = overview?.incidentStatus;
  const edge     = overview?.edgeReadiness;
  const mfaPct   = authHealth?.mfaTotal ? Math.round(((authHealth.mfaEnabled ?? 0) / authHealth.mfaTotal) * 100) : null;

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
            <p className="text-sm text-muted-foreground mt-0.5">Enterprise security posture, controls, brute-force, sessions, webhooks and backups</p>
          </div>
          <div className="flex items-center gap-2">
            {[6, 24, 72].map(h => (
              <Button key={h} size="sm" variant={windowHours === h ? "default" : "outline"} onClick={() => setWindowHours(h)} data-testid={`btn-window-${h}h`} className="text-xs">{h}h</Button>
            ))}
          </div>
        </div>

        {/* Posture Banner */}
        {ovL ? <Skeleton className="h-14" /> : (
          <Card className={`border ${postureVariant(posture?.status)}`} data-testid="security-posture-banner">
            <CardContent className="py-3 px-4 flex items-center gap-3">
              {postureIcon(posture?.status)}
              <div className="flex-1">
                <p className="text-sm font-medium">
                  Security posture: <strong className="capitalize">{posture?.status ?? "unknown"}</strong>
                  {" — "}{posture?.passing ?? 0} passing, {posture?.warnings ?? 0} warnings, {posture?.failing ?? 0} failing
                </p>
              </div>
              <Badge variant="outline" className="text-xs font-mono shrink-0">{posture?.coveragePercent ?? 0}% covered</Badge>
              {overview?.retrievedAt && (
                <span className="text-xs text-muted-foreground shrink-0">
                  <RefreshCw className="w-3 h-3 inline mr-1" />{new Date(overview.retrievedAt).toLocaleTimeString()}
                </span>
              )}
            </CardContent>
          </Card>
        )}

        {/* Auth Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {ahL ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />) : (<>
            <MetricCard label="Failed Logins (24h)"  value={authHealth?.failedLogins24h ?? null} icon={Lock}     testId="card-failed-logins" />
            <MetricCard label="Active Sessions"       value={authHealth?.activeSessions  ?? null} icon={Activity} testId="card-active-sessions" />
            <MetricCard label="MFA Enabled"           value={authHealth?.mfaEnabled      ?? null} icon={Shield}   testId="card-mfa-enabled" sub={mfaPct !== null ? `${mfaPct}% adoption` : undefined} />
            <MetricCard label="Blocked Accounts"      value={brute?.stats?.blockedEntries ?? null} icon={XCircle}  testId="card-blocked-accounts" sub="brute-force blocks" />
          </>)}
        </div>

        {/* Security Headers + Brute Force */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Headers Posture */}
          <Card className="bg-card border-card-border" data-testid="security-headers-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Globe className="w-4 h-4 text-muted-foreground" /> Security Headers Posture
                {!hdL && headers && (
                  <span className="ml-auto">{statusBadge(headers.validation.valid ? "pass" : "fail")}</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {hdL ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div> : (
                <div className="space-y-1.5">
                  {[
                    { name: "Content-Security-Policy", present: headers?.headers?.some(h => h.name.includes("CSP")) || !!headers?.csp },
                    { name: "Strict-Transport-Security", present: headers?.headers?.some(h => h.name === "Strict-Transport-Security") },
                    { name: "X-Frame-Options",          present: headers?.headers?.some(h => h.name === "X-Frame-Options") },
                    { name: "X-Content-Type-Options",   present: headers?.headers?.some(h => h.name === "X-Content-Type-Options") },
                    { name: "Referrer-Policy",          present: headers?.headers?.some(h => h.name === "Referrer-Policy") },
                    { name: "Permissions-Policy",       present: headers?.headers?.some(h => h.name === "Permissions-Policy") },
                  ].map(({ name, present }) => (
                    <div key={name} className="flex items-center justify-between py-1 border-b border-border last:border-0" data-testid={`header-check-${name.toLowerCase().replace(/[-\s]/g, "_")}`}>
                      <div className="flex items-center gap-2">{boolIcon(!!present)}<span className="text-xs font-mono text-muted-foreground">{name}</span></div>
                      {present ? <Badge variant="outline" className="text-xs bg-green-500/10 text-green-400 border-green-500/25">Active</Badge>
                               : <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/25">Missing</Badge>}
                    </div>
                  ))}
                  {headers?.isProduction === false && (
                    <p className="text-xs text-yellow-400 mt-2 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Dev mode — HSTS not enforced</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Brute Force */}
          <Card className="bg-card border-card-border" data-testid="brute-force-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Lock className="w-4 h-4 text-muted-foreground" /> Brute-Force / Auth Protection
                {!bfL && brute && brute.stats.blockedEntries > 0 && (
                  <Badge variant="outline" className="ml-auto text-xs bg-destructive/10 text-destructive border-destructive/25">{brute.stats.blockedEntries} blocked</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {bfL ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div> : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="bg-muted/30 rounded p-2"><p className="text-xs text-muted-foreground">Active Entries</p><p className="text-lg font-bold">{brute?.stats?.activeEntries ?? 0}</p></div>
                    <div className="bg-muted/30 rounded p-2"><p className="text-xs text-muted-foreground">Blocked Now</p><p className="text-lg font-bold text-destructive">{brute?.stats?.blockedEntries ?? 0}</p></div>
                  </div>
                  {(brute?.thresholds ?? []).map(t => (
                    <div key={t.attempts} className="flex items-center justify-between py-1 border-b border-border last:border-0" data-testid={`bf-threshold-${t.attempts}`}>
                      <span className="text-xs text-muted-foreground">{t.description}</span>
                      <Badge variant="outline" className="text-xs border-border text-muted-foreground font-mono">{t.attempts} fails → {t.cooldownSeconds}s</Badge>
                    </div>
                  ))}
                  {(brute?.stats?.topOffenders ?? []).slice(0, 3).map((o, i) => (
                    <div key={i} className="flex items-center justify-between py-1 border-b border-border last:border-0 text-xs" data-testid={`bf-offender-${i}`}>
                      <span className="font-mono text-muted-foreground truncate max-w-[160px]">{o.key.replace(/^bf:[^:]+:/, "")}</span>
                      <span className="text-destructive font-bold">{o.failures} failures</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Session Security + Webhook Security */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Session Security */}
          <Card className="bg-card border-card-border" data-testid="session-security-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Server className="w-4 h-4 text-muted-foreground" /> Session Security
              </CardTitle>
            </CardHeader>
            <CardContent>
              {seL ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div> : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="bg-muted/30 rounded p-2"><p className="text-xs text-muted-foreground">Active Sessions</p><p className="text-lg font-bold">{sessions?.totalActive ?? 0}</p></div>
                    <div className="bg-muted/30 rounded p-2"><p className="text-xs text-muted-foreground">Revoked (24h)</p><p className="text-lg font-bold">{sessions?.totalRevokedToday ?? 0}</p></div>
                  </div>
                  {(sessions?.recentRevocations ?? []).slice(0, 5).map((r, i) => (
                    <div key={i} className="flex items-center justify-between py-1 border-b border-border last:border-0" data-testid={`session-revocation-${i}`}>
                      <span className="text-xs font-mono text-muted-foreground">{r.reason.replace(/_/g, " ")}</span>
                      <span className="text-xs text-muted-foreground">{new Date(r.revokedAt).toLocaleTimeString()}</span>
                    </div>
                  ))}
                  {(!sessions?.recentRevocations?.length) && (
                    <p className="text-xs text-muted-foreground">No recent forced revocations</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Webhook Security */}
          <Card className="bg-card border-card-border" data-testid="webhook-security-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Webhook className="w-4 h-4 text-muted-foreground" /> Webhook Signature Verification
                {!whL && webhooks && webhooks.failures > 0 && (
                  <Badge variant="outline" className="ml-auto text-xs bg-destructive/10 text-destructive border-destructive/25">{webhooks.failures} failures</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {whL ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div> : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="bg-muted/30 rounded p-2"><p className="text-xs text-muted-foreground">Total Verified</p><p className="text-lg font-bold">{webhooks?.total ?? 0}</p></div>
                    <div className="bg-muted/30 rounded p-2"><p className="text-xs text-muted-foreground">Failures</p><p className="text-lg font-bold text-destructive">{webhooks?.failures ?? 0}</p></div>
                  </div>
                  {(webhooks?.recentFailures ?? []).slice(0, 5).map((f, i) => (
                    <div key={i} className="flex items-center justify-between py-1 border-b border-border last:border-0" data-testid={`webhook-failure-${i}`}>
                      <div>
                        <span className="text-xs font-mono text-muted-foreground">{f.provider}</span>
                        <span className="text-xs text-destructive ml-2">{f.reason}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{new Date(f.at).toLocaleTimeString()}</span>
                    </div>
                  ))}
                  {!webhooks?.recentFailures?.length && (
                    <p className="text-xs text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> No verification failures</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Backup Health */}
        <Card className="bg-card border-card-border" data-testid="backup-health-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="w-4 h-4 text-muted-foreground" /> Backup &amp; Restore Readiness
              {!buL && backup && <span className="ml-auto">{statusBadge(backup.health.overall)}</span>}
              <Button
                size="sm"
                variant="outline"
                className="ml-2 text-xs"
                disabled={dryRunMutation.isPending}
                onClick={() => dryRunMutation.mutate()}
                data-testid="btn-backup-dry-run"
              >
                {dryRunMutation.isPending ? "Running…" : "Run Dry-Run"}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {buL ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div> : (
              <div className="space-y-1">
                {(backup?.health?.items ?? []).map(item => (
                  <div key={item.name} className="flex items-center justify-between py-2 border-b border-border last:border-0" data-testid={`backup-item-${item.name.toLowerCase().replace(/\s+/g, "_")}`}>
                    <div className="flex items-center gap-2">
                      {checkIcon(item.status === "healthy" ? "pass" : item.status === "warning" ? "warn" : "fail")}
                      <div>
                        <p className="text-xs font-medium text-foreground">{item.name}</p>
                        <p className="text-xs text-muted-foreground">{item.detail}</p>
                      </div>
                    </div>
                    {statusBadge(item.status as any)}
                  </div>
                ))}
                {backup?.restore?.notes?.map((note, i) => (
                  <p key={i} className="text-xs text-muted-foreground flex items-start gap-1 mt-1">
                    <AlertCircle className="w-3 h-3 mt-0.5 shrink-0 text-yellow-400" /> {note}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Incident Readiness + Edge Readiness */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="bg-card border-card-border" data-testid="incident-readiness-card">
            <CardHeader className="pb-3"><CardTitle className="text-sm font-medium flex items-center gap-2"><Server className="w-4 h-4 text-muted-foreground" /> Incident Readiness</CardTitle></CardHeader>
            <CardContent>
              {ovL ? <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div> : (
                <div className="space-y-2">
                  {([
                    { label: "Audit Logs Active",    ok: incident?.auditLogsEnabled },
                    { label: "Rate Limits Active",   ok: incident?.rateLimitsActive },
                    { label: "MFA Available",        ok: incident?.mfaAvailable },
                    { label: "Secret Redaction",     ok: incident?.secretRedaction },
                    { label: "Security Headers",     ok: incident?.securityHeaders },
                    { label: "Backup Configured",    ok: incident?.backupConfigured },
                    { label: "Alerting Enabled",     ok: incident?.alertingEnabled },
                  ] as const).map(({ label, ok }) => (
                    <div key={label} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">{boolIcon(!!ok)}<span className="text-xs text-muted-foreground">{label}</span></div>
                      {ok ? <Badge variant="outline" className="text-xs bg-green-500/10 text-green-400 border-green-500/25">Active</Badge>
                          : <Badge variant="outline" className="text-xs bg-yellow-500/10 text-yellow-400 border-yellow-500/25">Missing</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-card-border" data-testid="edge-readiness-card">
            <CardHeader className="pb-3"><CardTitle className="text-sm font-medium flex items-center gap-2"><Cloud className="w-4 h-4 text-muted-foreground" /> Cloudflare Edge Readiness</CardTitle></CardHeader>
            <CardContent>
              {ovL ? <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div> : (
                <div className="space-y-2">
                  {([
                    { label: "CF Token Configured", ok: edge?.tokenConfigured },
                    { label: "R2 Connected",         ok: edge?.r2Connected },
                    { label: "WAF Ready",            ok: edge?.wafReady },
                    { label: "Bot Protection Ready", ok: edge?.botProtectionReady },
                    { label: "Rate Limit Ready",     ok: edge?.rateLimitReady },
                    { label: "Strict TLS Ready",     ok: edge?.strictTlsReady },
                    { label: "CORS Ready",           ok: edge?.corsReady },
                  ] as const).map(({ label, ok }) => (
                    <div key={label} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">{boolIcon(!!ok)}<span className="text-xs text-muted-foreground">{label}</span></div>
                      {ok ? <Badge variant="outline" className="text-xs bg-green-500/10 text-green-400 border-green-500/25">Ready</Badge>
                          : <Badge variant="outline" className="text-xs bg-muted text-muted-foreground border-border">Pending</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* SOC2 Checklist */}
        <Card className="bg-card border-card-border" data-testid="soc2-checklist-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Key className="w-4 h-4 text-muted-foreground" /> SOC2 Readiness Checklist
              {!clL && checklist && (<div className="ml-auto flex items-center gap-2">{statusBadge(checklist.overallStatus)}<span className="text-xs text-muted-foreground font-normal">{checklist.passing}/{checklist.totalChecks} passing</span></div>)}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {clL ? <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div> : (
              <div className="divide-y divide-border">
                {checklist?.checks.map(c => (
                  <div key={c.id} className="flex items-start gap-3 px-4 py-3" data-testid={`soc2-check-${c.id}`}>
                    {checkIcon(c.status)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-medium text-foreground">{c.name}</p>
                        <Badge variant="outline" className="text-xs font-mono text-muted-foreground border-border shrink-0">{c.soc2Control}</Badge>
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

        {/* Rate Limits */}
        <Card className="bg-card border-card-border" data-testid="rate-limit-policies-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Zap className="w-4 h-4 text-muted-foreground" /> Route-Group Rate Limit Policies
              {!rlL && rateLimits && <span className="ml-auto text-xs text-muted-foreground font-normal">{rateLimits.routeGroups.length} groups · {rateLimits.engineStats.activeKeys} active keys</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {rlL ? <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div> : (
              <div className="divide-y divide-border">
                {rateLimits?.routeGroups.map(g => (
                  <div key={g.group} className="flex items-center gap-3 px-4 py-2.5" data-testid={`rl-group-${g.group}`}>
                    <span className="text-xs font-mono text-foreground w-40 shrink-0">{g.group}</span>
                    <span className="text-xs text-muted-foreground flex-1 truncate">{g.description}</span>
                    <Badge variant="outline" className="text-xs font-mono border-border text-muted-foreground shrink-0">{g.maxRequests}/{g.windowSec}s</Badge>
                    <Badge variant="outline" className="text-xs border-border text-muted-foreground shrink-0">{g.keyStrategy}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Security Alerts */}
        <Card className="bg-card border-card-border" data-testid="security-alerts-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BellRing className="w-4 h-4 text-muted-foreground" /> Security Alerts
              {!alL && alerts && alerts.unresolvedCritical > 0 && (
                <Badge variant="outline" className="ml-auto text-xs bg-destructive/10 text-destructive border-destructive/25">{alerts.unresolvedCritical} critical</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {alL ? <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            : alerts?.alerts?.length ? (
              <div className="divide-y divide-border" data-testid="security-alerts-list">
                {alerts.alerts.slice(0, 20).map(a => (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-2.5" data-testid={`security-alert-${a.id}`}>
                    <span className="text-xs font-mono text-foreground w-48 shrink-0 truncate">{a.alertType.replace(/_/g, " ")}</span>
                    <span className="text-xs text-muted-foreground flex-1 truncate">{a.message}</span>
                    {statusBadge(a.severity as any)}
                    <span className="text-xs text-muted-foreground shrink-0">{new Date(a.emittedAt).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center">
                <Shield className="w-8 h-8 text-green-400/50 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="no-security-alerts-msg">No security alerts emitted</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Security Events Feed */}
        <Card className="bg-card border-card-border" data-testid="security-events-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Eye className="w-4 h-4 text-muted-foreground" /> Security Events Feed
              {!evL && events && <span className="ml-auto text-xs text-muted-foreground font-normal">{events.total} events in last {windowHours}h</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {evL ? <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            : events?.events?.length ? (
              <div className="divide-y divide-border" data-testid="security-events-list">
                {events.events.slice(0, 50).map(e => {
                  const type = e.event_type ?? e.eventType ?? "unknown";
                  return (
                    <div key={e.id} className="flex items-center gap-3 px-4 py-2.5" data-testid={`security-event-${e.id}`}>
                      <span className="text-xs font-mono text-foreground w-40 shrink-0 truncate">{type}</span>
                      <div className="flex-1 flex items-center gap-2 min-w-0">
                        {e.tenant_id && <span className="text-xs text-muted-foreground font-mono truncate max-w-[120px]">{e.tenant_id}</span>}
                        {e.ip && <span className="text-xs text-muted-foreground font-mono">{e.ip}</span>}
                      </div>
                      {e.severity && <Badge variant="outline" className={`text-xs shrink-0 ${e.severity === "critical" ? "bg-destructive/10 text-destructive border-destructive/25" : e.severity === "warning" ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/25" : "border-border text-muted-foreground"}`}>{e.severity}</Badge>}
                      <span className="text-xs text-muted-foreground shrink-0">{new Date(e.created_at).toLocaleTimeString()}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-8 text-center">
                <Shield className="w-8 h-8 text-green-400/50 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="no-security-events-msg">No security events in the last {windowHours}h</p>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
