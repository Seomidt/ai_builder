/**
 * Platform Integrations Health Dashboard
 *
 * Enterprise-grade admin dashboard showing live health status of all
 * platform-managed integrations. All checks are server-side only.
 * No secrets are ever exposed to the browser.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, AlertTriangle, Box,
  RefreshCw, Mail, Webhook, Clock, Zap,
  ShieldAlert, Activity,
} from "lucide-react";
import {
  SiOpenai, SiAnthropic, SiGooglegemini,
  SiGithub, SiStripe, SiSupabase, SiVercel, SiCloudflare,
} from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getSessionToken } from "@/lib/supabase";

// ── Types (mirror server canonical model) ─────────────────────────────────────

type HealthStatus = "connected" | "missing" | "invalid" | "expired" | "partial" | "rate_limited" | "stub";
type Severity = "critical" | "important" | "optional";
type ProviderGroup = "ai" | "platform" | "infrastructure";

interface ProviderHealth {
  key: string;
  label: string;
  description: string;
  category: ProviderGroup;
  severity: Severity;
  status: HealthStatus;
  requiredEnv: string[];
  missingEnv: string[];
  checkedAt: string;
  latencyMs: number | null;
  details: Record<string, boolean | string | null>;
  message: string;
}

interface HealthGroup {
  key: ProviderGroup;
  label: string;
  providers: ProviderHealth[];
}

interface HealthSummary {
  total: number;
  connected: number;
  missing: number;
  invalid: number;
  expired: number;
  partial: number;
  rate_limited: number;
  stub: number;
  criticalFailures: number;
}

interface IntegrationsHealthReport {
  summary: HealthSummary;
  groups: HealthGroup[];
  cachedAt: string;
  fromCache: boolean;
}

// ── Icon map ──────────────────────────────────────────────────────────────────

const PROVIDER_ICON: Record<string, { icon: React.ElementType; color: string }> = {
  openai:     { icon: SiOpenai,       color: "text-green-400" },
  anthropic:  { icon: SiAnthropic,    color: "text-orange-300" },
  gemini:     { icon: SiGooglegemini, color: "text-blue-400" },
  supabase:   { icon: SiSupabase,     color: "text-emerald-400" },
  github:     { icon: SiGithub,       color: "text-slate-200" },
  stripe:     { icon: SiStripe,       color: "text-violet-400" },
  vercel:     { icon: SiVercel,       color: "text-white" },
  cloudflare: { icon: SiCloudflare,   color: "text-orange-400" },
  email:      { icon: Mail,           color: "text-sky-400" },
  webhooks:   { icon: Webhook,        color: "text-cyan-400" },
};

// ── Status config ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<HealthStatus, {
  label: string;
  color: string;
  border: string;
  bg: string;
  dot: string;
  icon: React.ElementType;
}> = {
  connected:   { label: "Connected",    color: "text-green-400",  border: "border-green-500/30",  bg: "bg-green-500/10",  dot: "bg-green-400",  icon: CheckCircle2 },
  missing:     { label: "Missing",      color: "text-red-400",    border: "border-red-500/30",    bg: "bg-red-500/10",    dot: "bg-red-400",    icon: XCircle },
  invalid:     { label: "Invalid",      color: "text-red-400",    border: "border-red-500/30",    bg: "bg-red-500/10",    dot: "bg-red-400",    icon: XCircle },
  expired:     { label: "Expired",      color: "text-orange-400", border: "border-orange-500/30", bg: "bg-orange-500/10", dot: "bg-orange-400", icon: AlertTriangle },
  partial:     { label: "Partial",      color: "text-amber-400",  border: "border-amber-500/30",  bg: "bg-amber-500/10",  dot: "bg-amber-400",  icon: AlertTriangle },
  rate_limited:{ label: "Rate Limited", color: "text-amber-400",  border: "border-amber-500/30",  bg: "bg-amber-500/10",  dot: "bg-amber-400",  icon: AlertTriangle },
  stub:        { label: "Not Active",   color: "text-slate-400",  border: "border-slate-600/40",  bg: "bg-slate-500/8",   dot: "bg-slate-500",  icon: Box },
};

const SEVERITY_CONFIG: Record<Severity, { label: string; color: string; border: string; bg: string }> = {
  critical:  { label: "Critical",  color: "text-red-400",    border: "border-red-500/30",  bg: "bg-red-500/10" },
  important: { label: "Important", color: "text-amber-400",  border: "border-amber-500/30",bg: "bg-amber-500/10" },
  optional:  { label: "Optional",  color: "text-slate-400",  border: "border-slate-600/40",bg: "bg-slate-500/8" },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: HealthStatus }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <Badge variant="outline" className={`text-xs ${cfg.color} ${cfg.border} ${cfg.bg} gap-1`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  if (severity === "optional") return null;
  const cfg = SEVERITY_CONFIG[severity];
  return (
    <Badge variant="outline" className={`text-[10px] ${cfg.color} ${cfg.border} ${cfg.bg}`}>
      {cfg.label}
    </Badge>
  );
}

function ProviderCard({ provider }: { provider: ProviderHealth }) {
  const iconMeta = PROVIDER_ICON[provider.key];
  const Icon = iconMeta?.icon ?? Box;
  const iconColor = iconMeta?.color ?? "text-slate-400";
  const statusCfg = STATUS_CONFIG[provider.status];
  const isHealthy = provider.status === "connected";
  const isProblematic = ["missing", "invalid", "expired"].includes(provider.status);

  const checkedTime = new Date(provider.checkedAt).toLocaleTimeString("da-DK", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <Card
      className={`bg-card border-card-border relative overflow-hidden transition-all duration-200 hover:-translate-y-0.5 ${isProblematic && provider.severity === "critical" ? "border-red-500/30" : ""}`}
      data-testid={`integration-card-${provider.key}`}
    >
      {/* Left severity bar */}
      <span className={`absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full ${
        provider.severity === "critical" ? "bg-red-500" :
        provider.severity === "important" ? "bg-amber-500" : "bg-slate-600"
      }`} />

      <CardContent className="pt-4 pb-4 pl-5">
        {/* Header row */}
        <div className="flex items-start gap-3 mb-3">
          <div className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${
            isHealthy ? "bg-green-500/10" : isProblematic ? "bg-red-500/10" : "bg-muted/50"
          }`}>
            <Icon className={`w-4.5 h-4.5 ${iconColor}`} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
              <span className="text-sm font-semibold text-foreground leading-tight">{provider.label}</span>
              <StatusBadge status={provider.status} />
              <SeverityBadge severity={provider.severity} />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{provider.description}</p>
          </div>
        </div>

        {/* Status message */}
        <p className={`text-xs mb-3 leading-relaxed ${isProblematic ? "text-red-400/80" : provider.status === "partial" || provider.status === "rate_limited" ? "text-amber-400/80" : "text-muted-foreground"}`}>
          {provider.message}
        </p>

        {/* Missing env vars */}
        {provider.missingEnv.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {provider.missingEnv.map((v) => (
              <code
                key={v}
                className="text-[10px] font-mono bg-red-500/10 border border-red-500/20 text-red-400 px-1.5 py-0.5 rounded"
                data-testid={`missing-env-${provider.key}-${v}`}
              >
                {v}
              </code>
            ))}
          </div>
        )}

        {/* Capability details */}
        {provider.status === "connected" && Object.keys(provider.details).length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {Object.entries(provider.details)
              .filter(([, v]) => v !== null && v !== false)
              .map(([k, v]) => (
                <span key={k} className="text-[10px] font-mono bg-green-500/8 border border-green-500/15 text-green-400/70 px-1.5 py-0.5 rounded flex items-center gap-1">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  {k}{typeof v === "string" ? `: ${v}` : ""}
                </span>
              ))}
          </div>
        )}

        {/* Footer: latency + checked time */}
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground/50">
          {provider.latencyMs !== null && (
            <span className="flex items-center gap-1">
              <Zap className="w-2.5 h-2.5" />
              {provider.latencyMs}ms
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            Checked {checkedTime}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryStatPill({
  count, label, color,
}: { count: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-base font-bold tabular-nums ${color}`}>{count}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Integrations() {
  const queryClient = useQueryClient();

  const { data, isLoading, error, isFetching } = useQuery<IntegrationsHealthReport>({
    queryKey: ["/api/admin/integrations/health"],
    queryFn: async () => {
      const token = await getSessionToken();
      const res = await fetch("/api/admin/integrations/health", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  function handleRefresh() {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/integrations/health"] });
  }

  const s = data?.summary;
  const hasCriticalFailures = (s?.criticalFailures ?? 0) > 0;
  const hasProblems = s ? (s.missing + s.invalid + s.expired) > 0 : false;

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl" data-testid="integrations-page">

      {/* ── Page header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.18)" }}
            >
              <Activity className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-integrations-title">
              Platform Integrations
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Platform-managed integrations used by BlissOps runtime, orchestration and operations. Secrets are server-side only.
          </p>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          data-testid="button-refresh-integrations"
          className="text-muted-foreground shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? "Checking..." : "Refresh"}
        </Button>
      </div>

      {/* ── Critical alert banner ────────────────────────────────────────────── */}
      {!isLoading && hasCriticalFailures && (
        <Card
          className="border-red-500/30"
          style={{ background: "rgba(239,68,68,0.07)" }}
          data-testid="critical-alert-banner"
        >
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-400 mb-1">
                  {s!.criticalFailures} critical provider{s!.criticalFailures !== 1 ? "s" : ""} degraded
                </p>
                <p className="text-xs text-red-400/70 leading-relaxed">
                  OpenAI and Supabase are required for core platform operation. Missing or invalid credentials will cause LLM execution, auth, and data operations to fail.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Error state ──────────────────────────────────────────────────────── */}
      {error && !isLoading && (
        <Card className="bg-destructive/8 border-destructive/25">
          <CardContent className="pt-4 flex items-center gap-2">
            <XCircle className="w-4 h-4 text-destructive shrink-0" />
            <p className="text-sm text-destructive">
              Health check failed — {(error as Error).message}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Summary bar ──────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex gap-6 flex-wrap">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-24" />)}
        </div>
      ) : s ? (
        <Card className="bg-card/50 border-card-border" data-testid="summary-bar">
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-wrap gap-x-6 gap-y-3 items-center">
              <SummaryStatPill count={s.connected}    label="connected"    color="text-green-400" />
              {s.missing > 0      && <SummaryStatPill count={s.missing}      label="missing"      color="text-red-400" />}
              {s.invalid > 0      && <SummaryStatPill count={s.invalid}      label="invalid"      color="text-red-400" />}
              {s.expired > 0      && <SummaryStatPill count={s.expired}      label="expired"      color="text-orange-400" />}
              {s.partial > 0      && <SummaryStatPill count={s.partial}      label="partial"      color="text-amber-400" />}
              {s.rate_limited > 0 && <SummaryStatPill count={s.rate_limited} label="rate limited" color="text-amber-400" />}
              {s.stub > 0         && <SummaryStatPill count={s.stub}         label="not active"   color="text-slate-400" />}

              <div className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <Clock className="w-3 h-3" />
                {data?.fromCache ? "From cache" : "Fresh check"} ·{" "}
                {new Date(data?.cachedAt ?? "").toLocaleTimeString("da-DK")}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Provider groups ───────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="space-y-8">
          {[3, 3, 4].map((count, gi) => (
            <div key={gi} className="space-y-3">
              <Skeleton className="h-4 w-28" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {Array.from({ length: count }).map((_, i) => (
                  <Skeleton key={i} className="h-36 rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          {data?.groups.map(({ key, label, providers }) => {
            const groupConnected = providers.filter((p) => p.status === "connected").length;
            return (
              <div key={key} data-testid={`group-${key}`}>
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</h2>
                  <div className="flex-1 h-px bg-white/5" />
                  <span className="text-xs text-muted-foreground/50">
                    {groupConnected}/{providers.length} connected
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {providers.map((provider) => (
                    <ProviderCard key={provider.key} provider={provider} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Problems summary (non-critical) ──────────────────────────────────── */}
      {!isLoading && hasProblems && !hasCriticalFailures && (
        <Card className="border-amber-500/25" style={{ background: "rgba(245,158,11,0.06)" }}>
          <CardContent className="pt-4 pb-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-300/80 leading-relaxed">
              {(s?.missing ?? 0) + (s?.invalid ?? 0) + (s?.expired ?? 0)} provider{((s?.missing ?? 0) + (s?.invalid ?? 0) + (s?.expired ?? 0)) !== 1 ? "s" : ""} need attention.
              Configure the missing environment variables in the Vercel dashboard to enable full platform functionality.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
