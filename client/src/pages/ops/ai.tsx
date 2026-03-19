import { useQuery, useMutation } from "@tanstack/react-query";
import {
  BrainCircuit, AlertTriangle, CheckCircle, DollarSign,
  Bell, RefreshCw, TrendingUp, Shield,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Alert {
  id: string;
  alertType?: string;
  organizationId?: string;
  severity?: string;
  status?: string;
  message?: string;
  createdAt?: string;
}

interface BudgetResult {
  organizationId: string;
  status?: string;
  usagePct?: number;
  budgetUsd?: number;
  usedUsd?: number;
}

interface AiOpsAudit {
  entries?: { action: string; organizationId?: string; outcome: string; ts: string }[];
  stats?: { total: number; success: number; failure: number };
}

function severityColor(s?: string) {
  if (s === "critical") return "bg-destructive/15 text-destructive border-destructive/25";
  if (s === "high") return "bg-secondary/15 text-secondary border-secondary/25";
  return "bg-muted text-muted-foreground border-border";
}

function statusColor(s?: string) {
  if (s === "ok") return "bg-green-500/15 text-green-400 border-green-500/25";
  if (s === "warning") return "bg-secondary/15 text-secondary border-secondary/25";
  if (s === "critical") return "bg-destructive/15 text-destructive border-destructive/25";
  return "bg-muted text-muted-foreground border-border";
}

export default function OpsAi() {
  const { toast } = useToast();

  const { data: alerts, isLoading: alertsLoading } = useQuery<{ alerts?: Alert[] } | Alert[]>({
    queryKey: ["/api/admin/governance/alerts"],
  });
  const { data: budgets, isLoading: budgetsLoading } = useQuery<{ results?: BudgetResult[] } | BudgetResult[]>({
    queryKey: ["/api/admin/governance/budgets"],
  });
  const { data: audit, isLoading: auditLoading } = useQuery<AiOpsAudit>({
    queryKey: ["/api/admin/ai-ops/audit"],
  });

  const alertList: Alert[] = Array.isArray(alerts) ? alerts : (alerts?.alerts ?? []);
  const budgetList: BudgetResult[] = Array.isArray(budgets) ? budgets : (budgets?.results ?? []);

  const runBudgetCheck = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/governance/alerts/generate/budget", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/governance/alerts"] });
      toast({ title: "Budget check complete", description: "Alerts refreshed" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-ai-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2" data-testid="text-ops-ai-title">
            <BrainCircuit className="w-5 h-5 text-primary" /> AI Governance
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Budget health, anomaly alerts, and AI audit log</p>
        </div>
        <Button
          variant="outline" size="sm" className="gap-1.5"
          onClick={() => runBudgetCheck.mutate()}
          disabled={runBudgetCheck.isPending}
          data-testid="button-run-budget-check"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${runBudgetCheck.isPending ? "animate-spin" : ""}`} />
          {runBudgetCheck.isPending ? "Checking…" : "Run Budget Check"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Open Alerts */}
        <Card className="bg-card border-card-border" data-testid="ops-ai-alerts-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Bell className="w-4 h-4 text-primary" /> Open Alerts
              {!alertsLoading && (
                <Badge variant="outline" className="ml-auto text-xs">{alertList.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {alertsLoading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : alertList.length ? (
              <div data-testid="ai-alerts-list">
                {alertList.slice(0, 8).map((a) => (
                  <div key={a.id} className="flex items-start justify-between px-4 py-3 border-b border-border last:border-0" data-testid={`alert-row-${a.id}`}>
                    <div className="flex-1 min-w-0 pr-2">
                      <p className="text-xs text-foreground truncate">{a.message ?? a.alertType ?? "Alert"}</p>
                      <p className="text-xs text-muted-foreground font-mono">{(a.organizationId ?? "platform").slice(0, 12)}</p>
                    </div>
                    <Badge variant="outline" className={`text-xs shrink-0 ${severityColor(a.severity)}`} data-testid={`alert-severity-${a.id}`}>
                      {a.severity ?? "info"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center" data-testid="no-alerts-msg">
                <CheckCircle className="w-8 h-8 text-green-400/60 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No open alerts — all budgets within limits</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Budget Status */}
        <Card className="bg-card border-card-border" data-testid="ops-ai-budgets-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-primary" /> Budget Status
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {budgetsLoading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : budgetList.length ? (
              <div data-testid="budgets-list">
                {budgetList.slice(0, 8).map((b, i) => (
                  <div key={b.organizationId} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0" data-testid={`budget-row-${i}`}>
                    <div className="flex-1 min-w-0 pr-2">
                      <p className="text-xs font-mono text-muted-foreground truncate">{b.organizationId.slice(0, 12)}…</p>
                      {b.usagePct != null && (
                        <div className="h-1 bg-muted rounded-full mt-1.5 overflow-hidden">
                          <div className="h-full bg-primary rounded-full" style={{ width: `${Math.min(b.usagePct, 100)}%` }} />
                        </div>
                      )}
                    </div>
                    <Badge variant="outline" className={`text-xs shrink-0 ${statusColor(b.status)}`} data-testid={`budget-status-${i}`}>
                      {b.status ?? "unknown"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center" data-testid="no-budgets-msg">
                <TrendingUp className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No budgets configured</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* AI Ops Audit */}
      <Card className="bg-card border-card-border" data-testid="ops-ai-audit-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" /> AI Ops Audit Log
            {audit?.stats && (
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {audit.stats.success}/{audit.stats.total} successful
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {auditLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : audit?.entries?.length ? (
            <div data-testid="ai-audit-list">
              {audit.entries.slice(0, 10).map((e, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0" data-testid={`audit-row-${i}`}>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${e.outcome === "success" ? "bg-green-500/15 text-green-400" : "bg-destructive/15 text-destructive"}`}>
                      {e.outcome}
                    </span>
                    <span className="text-xs text-foreground">{e.action}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center" data-testid="no-audit-msg">
              <Shield className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No AI ops activity yet</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
