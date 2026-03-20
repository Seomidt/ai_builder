import { useQuery } from "@tanstack/react-query";
import { RefreshCw, TrendingUp, AlertTriangle, XCircle, CheckCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { QUERY_POLICY } from "@/lib/query-policy";
import { cn } from "@/lib/utils";

interface BudgetRow {
  organizationId: string;
  periodType: string;
  status: "under_budget" | "warning" | "exceeded" | "no_budget";
  budgetUsdCents: string | number;
  currentUsageUsdCents: string | number;
  utilizationPct: number;
  warningThresholdPct: number;
  hardLimitPct: number;
  periodStart: string;
  periodEnd: string;
  checkedAt: string;
}

interface BudgetsResponse {
  data: BudgetRow[];
  errors: { organizationId: string; error: string }[];
}

function centsToUsd(cents: string | number): string {
  return "$" + (Number(cents) / 100).toFixed(2);
}

function statusConfig(status: string) {
  if (status === "exceeded")   return { label: "Exceeded",    color: "text-destructive border-destructive/30 bg-destructive/10", icon: XCircle };
  if (status === "warning")    return { label: "Warning",     color: "text-yellow-500 border-yellow-500/30 bg-yellow-500/10", icon: AlertTriangle };
  if (status === "under_budget") return { label: "OK",        color: "text-green-400 border-green-500/30 bg-green-500/10", icon: CheckCircle };
  return { label: "No Budget", color: "text-muted-foreground border-border", icon: TrendingUp };
}

function UtilBar({ pct, status }: { pct: number; status: string }) {
  const color = status === "exceeded" ? "bg-destructive" : status === "warning" ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

export default function GovernanceBudgets() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === "platform_admin";

  const { data, isLoading, error, refetch, isFetching } = useQuery<BudgetsResponse>({
    queryKey: ["/api/admin/governance/budgets"],
    ...QUERY_POLICY.staticList,
    enabled: isPlatformAdmin,
    retry: false,
  });

  const sorted = [...(data?.data ?? [])].sort((a, b) => b.utilizationPct - a.utilizationPct);
  const errors = data?.errors ?? [];

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">AI Budgets</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Per-tenant budget utilisation — monthly period · sorted by usage
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-budgets"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Summary cards */}
      {!isLoading && data && (
        <div className="grid grid-cols-3 gap-3">
          {(["exceeded", "warning", "under_budget"] as const).map((s) => {
            const count = sorted.filter((r) => r.status === s).length;
            const cfg   = statusConfig(s);
            return (
              <Card key={s} className="bg-card border-card-border">
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground">{cfg.label}</p>
                  <p className="text-2xl font-semibold text-foreground mt-0.5">{count}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Table */}
      <Card className="bg-card border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-card-foreground">All Tenant Budgets</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-destructive">
              Failed to load budgets — {(error as Error).message}
            </div>
          ) : sorted.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No active budgets configured. Use the governance cycle API to seed budgets.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="text-left px-4 py-2.5 font-medium">Organisation</th>
                    <th className="text-left px-4 py-2.5 font-medium">Period</th>
                    <th className="text-right px-4 py-2.5 font-medium">Budget</th>
                    <th className="text-right px-4 py-2.5 font-medium">Used</th>
                    <th className="text-left px-4 py-2.5 font-medium w-32">Utilisation</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => {
                    const cfg = statusConfig(row.status);
                    const Icon = cfg.icon;
                    return (
                      <tr key={`${row.organizationId}-${row.periodType}`}
                          className="border-b border-border/30 hover:bg-muted/30 transition-colors"
                          data-testid={`row-budget-${row.organizationId}`}>
                        <td className="px-4 py-3 font-mono text-foreground truncate max-w-[180px]" title={row.organizationId}>
                          {row.organizationId.slice(0, 12)}…
                        </td>
                        <td className="px-4 py-3 capitalize text-muted-foreground">{row.periodType}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{centsToUsd(row.budgetUsdCents)}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{centsToUsd(row.currentUsageUsdCents)}</td>
                        <td className="px-4 py-3 w-32">
                          <div className="space-y-1">
                            <UtilBar pct={row.utilizationPct} status={row.status} />
                            <span className="text-muted-foreground">{row.utilizationPct.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={cn("text-xs border gap-1", cfg.color)}>
                            <Icon className="w-3 h-3" />
                            {cfg.label}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {errors.length > 0 && (
        <Card className="bg-card border-destructive/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-destructive">Budget Check Errors ({errors.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-3 space-y-1">
            {errors.map((e) => (
              <p key={e.organizationId} className="text-xs text-muted-foreground font-mono">
                {e.organizationId}: {e.error}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
