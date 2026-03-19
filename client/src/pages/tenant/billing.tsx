import { useQuery } from "@tanstack/react-query";
import { CreditCard, DollarSign, TrendingUp, AlertTriangle, CheckCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";

interface BillingData {
  tenantId: string;
  budget: {
    monthlyBudgetUsd: number;
    dailyBudgetUsd: number | null;
    softLimitPercent: number;
    hardLimitPercent: number;
    updatedAt: string;
  } | null;
  currentMonthSpendUsd: number;
  utilizationPercent: number;
  retrievedAt: string;
}

function UtilizationBar({ pct, soft, hard }: { pct: number; soft: number; hard: number }) {
  const color =
    pct >= hard ? "bg-destructive" :
    pct >= soft ? "bg-secondary" :
    "bg-primary";

  return (
    <div className="space-y-1.5" data-testid="budget-utilization-bar">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">Budget utilization</span>
        <span className="font-medium" data-testid="utilization-percent">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Soft limit: {soft}%</span>
        <span>Hard limit: {hard}%</span>
      </div>
    </div>
  );
}

export default function TenantBilling() {
  const { data, isLoading } = useQuery<BillingData>({
    queryKey: ["/api/tenant/billing"],
  });

  const pct  = data?.utilizationPercent ?? 0;
  const soft = data?.budget?.softLimitPercent ?? 80;
  const hard = data?.budget?.hardLimitPercent ?? 100;

  const statusLabel =
    pct >= hard ? "Hard Limit Reached" :
    pct >= soft ? "Soft Limit Warning" :
    "Normal";

  const statusColor =
    pct >= hard ? "bg-destructive/15 text-destructive border-destructive/25" :
    pct >= soft ? "bg-secondary/15 text-secondary border-secondary/25" :
    "bg-green-500/15 text-green-400 border-green-500/25";

  return (
    <div className="flex flex-col h-full">
      <TenantNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-primary" /> Billing
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Subscription, usage costs, and budget management</p>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-48" />
          </div>
        ) : (
          <>
            {/* Current Period Summary */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card className="bg-card border-card-border" data-testid="billing-card-spend">
                <CardContent className="pt-5">
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="w-4 h-4 text-primary" />
                    <p className="text-xs text-muted-foreground">This Month</p>
                  </div>
                  <p className="text-2xl font-bold" data-testid="billing-current-spend">
                    ${(data?.currentMonthSpendUsd ?? 0).toFixed(4)}
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-card border-card-border" data-testid="billing-card-budget">
                <CardContent className="pt-5">
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="w-4 h-4 text-primary" />
                    <p className="text-xs text-muted-foreground">Monthly Budget</p>
                  </div>
                  <p className="text-2xl font-bold" data-testid="billing-monthly-budget">
                    {data?.budget ? `$${data.budget.monthlyBudgetUsd.toFixed(2)}` : "—"}
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-card border-card-border" data-testid="billing-card-status">
                <CardContent className="pt-5">
                  <div className="flex items-center gap-2 mb-1">
                    {pct >= soft
                      ? <AlertTriangle className="w-4 h-4 text-secondary" />
                      : <CheckCircle className="w-4 h-4 text-green-400" />}
                    <p className="text-xs text-muted-foreground">Budget Status</p>
                  </div>
                  <Badge variant="outline" className={statusColor} data-testid="billing-status-badge">
                    {statusLabel}
                  </Badge>
                </CardContent>
              </Card>
            </div>

            {/* Budget Details */}
            {data?.budget ? (
              <Card className="bg-card border-card-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Budget Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <UtilizationBar pct={pct} soft={soft} hard={hard} />
                  <div className="grid grid-cols-2 gap-3 pt-2">
                    {[
                      { label: "Monthly Budget", value: `$${data.budget.monthlyBudgetUsd.toFixed(2)}` },
                      { label: "Daily Budget",   value: data.budget.dailyBudgetUsd != null ? `$${data.budget.dailyBudgetUsd.toFixed(2)}` : "Not set" },
                      { label: "Soft Limit",     value: `${data.budget.softLimitPercent}%` },
                      { label: "Hard Limit",     value: `${data.budget.hardLimitPercent}%` },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <span className="text-sm font-medium" data-testid={`billing-${label.toLowerCase().replace(/\s/g, "-")}`}>{value}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card className="bg-card border-card-border">
                <CardContent className="py-8 text-center">
                  <CreditCard className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground" data-testid="no-budget-msg">
                    No budget configured. Contact your platform administrator.
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
