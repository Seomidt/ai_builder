import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  BrainCircuit, RefreshCcw, AlertTriangle, CheckCircle,
  ChevronDown, ChevronUp, History, Zap, ShieldAlert, Info,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Types (mirrors shared/ops-ai-schema.ts) ───────────────────────────────────

interface TopIssue {
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  evidence: string[];
  confidence: "low" | "medium" | "high";
}
interface SuspectedCorrelation {
  title: string;
  reasoning: string;
  confidence: "low" | "medium" | "high";
}
interface RecommendedAction {
  action: string;
  reason: string;
  priority: 1 | 2 | 3;
}
interface OpsAiResponse {
  overall_health: "good" | "warning" | "critical";
  summary: string;
  top_issues: TopIssue[];
  suspected_correlations: SuspectedCorrelation[];
  recommended_actions: RecommendedAction[];
  unknowns: string[];
  generatedAt?: string;
}

interface AuditRecord {
  id: string;
  requestType: string;
  operatorId: string | null;
  responseSummary: string | null;
  confidence: string | null;
  tokensUsed: number | null;
  modelUsed: string | null;
  createdAt: string;
}

// ── Severity / confidence colour maps ────────────────────────────────────────

function severityColor(s: string) {
  return { critical: "bg-destructive/15 text-destructive border-destructive/25",
           high:     "bg-secondary/15 text-secondary border-secondary/25",
           medium:   "bg-primary/15 text-primary border-primary/25",
           low:      "bg-muted text-muted-foreground border-border" }[s] ?? "bg-muted text-muted-foreground border-border";
}

function confidenceColor(c: string) {
  return { high: "text-green-400", medium: "text-secondary", low: "text-muted-foreground" }[c] ?? "text-muted-foreground";
}

function healthColor(h: string) {
  return { good: "bg-green-500/5 border-green-500/25 text-green-400",
           warning: "bg-secondary/5 border-secondary/25 text-secondary",
           critical: "bg-destructive/5 border-destructive/25 text-destructive" }[h] ?? "bg-muted border-border text-muted-foreground";
}

function healthIcon(h: string) {
  if (h === "good")     return <CheckCircle className="w-4 h-4" />;
  if (h === "critical") return <AlertTriangle className="w-4 h-4" />;
  return <AlertTriangle className="w-4 h-4" />;
}

const INCIDENT_TYPES = [
  { value: "failed_jobs",           label: "Failed Jobs" },
  { value: "webhook_failure_spike", label: "Webhook Failure Spike" },
  { value: "billing_desync",        label: "Billing Desync" },
  { value: "ai_budget_spike",       label: "AI Budget Spike" },
  { value: "brownout_transition",   label: "Brownout Transition" },
  { value: "rate_limit_surge",      label: "Rate Limit Surge" },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function HealthBanner({ response }: { response: OpsAiResponse }) {
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${healthColor(response.overall_health)}`}
      data-testid="ops-ai-health-banner">
      {healthIcon(response.overall_health)}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold capitalize">{response.overall_health.replace("_", " ")}</p>
        <p className="text-xs mt-0.5" data-testid="ops-ai-summary-text">{response.summary}</p>
      </div>
      {response.generatedAt && (
        <span className="text-xs opacity-60 shrink-0">
          {new Date(response.generatedAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}

function TopIssuesCard({ issues }: { issues: TopIssue[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!issues.length) return (
    <Card className="bg-card border-card-border" data-testid="ops-ai-top-issues">
      <CardContent className="py-4 text-center text-sm text-muted-foreground">No top issues detected</CardContent>
    </Card>
  );
  return (
    <Card className="bg-card border-card-border" data-testid="ops-ai-top-issues">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-destructive" /> Top Issues ({issues.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {issues.map((issue, i) => (
          <div key={i} className="border-b border-border last:border-0" data-testid={`ops-ai-issue-${i}`}>
            <button
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/20 transition-colors"
              onClick={() => setExpanded(expanded === i ? null : i)}
              data-testid={`button-expand-issue-${i}`}
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Badge variant="outline" className={`text-xs shrink-0 ${severityColor(issue.severity)}`}
                  data-testid={`ops-ai-issue-severity-${i}`}>
                  {issue.severity}
                </Badge>
                <span className="text-sm font-medium truncate">{issue.title}</span>
              </div>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <span className={`text-xs ${confidenceColor(issue.confidence)}`}
                  data-testid={`ops-ai-issue-confidence-${i}`}>
                  {issue.confidence} conf.
                </span>
                {expanded === i ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </div>
            </button>
            {expanded === i && issue.evidence.length > 0 && (
              <div className="px-4 pb-3 pt-0" data-testid={`ops-ai-issue-evidence-${i}`}>
                <ul className="space-y-1">
                  {issue.evidence.map((e, j) => (
                    <li key={j} className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <span className="shrink-0 mt-0.5 text-destructive">•</span> {e}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CorrelationsCard({ correlations }: { correlations: SuspectedCorrelation[] }) {
  if (!correlations.length) return null;
  return (
    <Card className="bg-card border-card-border" data-testid="ops-ai-correlations">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" /> Suspected Correlations ({correlations.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {correlations.map((c, i) => (
          <div key={i} className="px-4 py-3 border-b border-border last:border-0" data-testid={`ops-ai-correlation-${i}`}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-medium">{c.title}</p>
              <span className={`text-xs ${confidenceColor(c.confidence)}`}
                data-testid={`ops-ai-correlation-confidence-${i}`}>
                {c.confidence} conf.
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{c.reasoning}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ActionsCard({ actions }: { actions: RecommendedAction[] }) {
  if (!actions.length) return null;
  return (
    <Card className="bg-card border-card-border" data-testid="ops-ai-actions">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-green-400" /> Recommended Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {[...actions].sort((a, b) => a.priority - b.priority).map((act, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-0"
            data-testid={`ops-ai-action-${i}`}>
            <div className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold shrink-0 mt-0.5">
              {act.priority}
            </div>
            <div>
              <p className="text-sm font-medium" data-testid={`ops-ai-action-text-${i}`}>{act.action}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{act.reason}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function UnknownsCard({ unknowns }: { unknowns: string[] }) {
  if (!unknowns.length) return null;
  return (
    <Card className="bg-card border-card-border" data-testid="ops-ai-unknowns">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Info className="w-4 h-4 text-muted-foreground" /> Uncertainties
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {unknowns.map((u, i) => (
          <div key={i} className="px-4 py-2 border-b border-border last:border-0">
            <p className="text-xs text-muted-foreground" data-testid={`ops-ai-unknown-${i}`}>{u}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function OpsAssistant() {
  const { toast } = useToast();
  const [incidentType, setIncidentType] = useState<string>("");
  const [showHistory, setShowHistory] = useState(false);

  const { data: summary, isLoading: summaryLoading, refetch: refetchSummary } =
    useQuery<OpsAiResponse>({
      queryKey: ["/api/admin/ops-ai/summary"],
    });

  const { data: history, isLoading: historyLoading } =
    useQuery<{ records: AuditRecord[]; count: number }>({
      queryKey: ["/api/admin/ops-ai/history"],
      enabled: showHistory,
    });

  const explainMutation = useMutation({
    mutationFn: (type: string) =>
      apiRequest<OpsAiResponse>("POST", "/api/admin/ops-ai/explain", {
        type,
        windowHours: 24,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ops-ai/history"] });
      toast({ title: "Incident analysis complete" });
    },
    onError: (err: Error) => toast({ title: "Analysis failed", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <BrainCircuit className="w-5 h-5 text-destructive" /> AI Operations Assistant
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Advisory only — AI interprets platform telemetry, never executes actions
            </p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5"
            onClick={() => refetchSummary()}
            disabled={summaryLoading}
            data-testid="button-refresh-summary">
            <RefreshCcw className={`w-3.5 h-3.5 ${summaryLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Disclaimer */}
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border">
          <ShieldAlert className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground" data-testid="ops-ai-disclaimer">
            AI outputs are advisory only. Confidence levels indicate data quality. Always verify with raw telemetry before acting.
          </p>
        </div>

        {/* Section 1: Health Summary */}
        <div className="space-y-3" data-testid="ops-ai-health-section">
          <h2 className="text-sm font-semibold text-foreground">Overall Health Summary</h2>
          {summaryLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20" />
              <Skeleton className="h-32" />
            </div>
          ) : summary ? (
            <>
              <HealthBanner response={summary} />
              <TopIssuesCard issues={summary.top_issues ?? []} />
              <CorrelationsCard correlations={summary.suspected_correlations ?? []} />
              <ActionsCard actions={summary.recommended_actions ?? []} />
              <UnknownsCard unknowns={summary.unknowns ?? []} />
            </>
          ) : (
            <div className="py-8 text-center">
              <BrainCircuit className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground" data-testid="ops-ai-no-summary-msg">
                No summary available. Click Refresh to generate one.
              </p>
            </div>
          )}
        </div>

        {/* Section 2: Incident Explainer */}
        <div className="space-y-3" data-testid="ops-ai-incident-section">
          <h2 className="text-sm font-semibold text-foreground">Incident Explainer</h2>
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Select an incident type to get an AI-powered explanation of probable causes and investigation steps.
              </p>
              <div className="flex items-center gap-3">
                <Select onValueChange={setIncidentType} value={incidentType}>
                  <SelectTrigger className="flex-1" data-testid="select-incident-type">
                    <SelectValue placeholder="Select incident type…" />
                  </SelectTrigger>
                  <SelectContent>
                    {INCIDENT_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}
                        data-testid={`option-incident-${t.value}`}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={() => incidentType && explainMutation.mutate(incidentType)}
                  disabled={!incidentType || explainMutation.isPending}
                  className="gap-2 shrink-0"
                  data-testid="button-explain-incident">
                  <BrainCircuit className="w-4 h-4" />
                  {explainMutation.isPending ? "Analysing…" : "Explain"}
                </Button>
              </div>

              {explainMutation.data && (
                <div className="pt-2 space-y-3 border-t border-border" data-testid="ops-ai-incident-result">
                  <HealthBanner response={explainMutation.data} />
                  <TopIssuesCard issues={explainMutation.data.top_issues ?? []} />
                  <ActionsCard actions={explainMutation.data.recommended_actions ?? []} />
                  <UnknownsCard unknowns={explainMutation.data.unknowns ?? []} />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Section 3: Recent Runs */}
        <div className="space-y-3" data-testid="ops-ai-history-section">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Recent Assistant Runs</h2>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs"
              onClick={() => setShowHistory((v) => !v)}
              data-testid="button-toggle-history">
              <History className="w-3.5 h-3.5" />
              {showHistory ? "Hide" : "Show"} History
            </Button>
          </div>

          {showHistory && (
            <Card className="bg-card border-card-border">
              <CardContent className="p-0">
                {historyLoading ? (
                  <div className="p-4 space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
                  </div>
                ) : history?.records?.length ? (
                  <div data-testid="ops-ai-history-list">
                    {history.records.map((r) => (
                      <div key={r.id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0 text-xs"
                        data-testid={`ops-ai-history-row-${r.id}`}>
                        <div>
                          <span className="font-mono text-muted-foreground">{r.requestType}</span>
                          {r.responseSummary && (
                            <p className="text-muted-foreground truncate max-w-xs mt-0.5">{r.responseSummary.slice(0, 80)}…</p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0 ml-3">
                          {r.confidence && (
                            <span className={confidenceColor(r.confidence)}>{r.confidence}</span>
                          )}
                          {r.modelUsed && (
                            <span className="text-muted-foreground/50">{r.modelUsed}</span>
                          )}
                          <span className="text-muted-foreground/50">
                            {new Date(r.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-6 text-center">
                    <p className="text-sm text-muted-foreground" data-testid="ops-ai-no-history-msg">
                      No assistant runs recorded yet
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
