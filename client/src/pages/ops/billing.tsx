import { useQuery } from "@tanstack/react-query";
import { CreditCard, TrendingUp, AlertTriangle, CheckCircle, DollarSign } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";

interface BillingResponse {
  health: {
    healthy?: boolean;
    totalSubscriptions?: number;
    activeSubscriptions?: number;
    failedPayments?: number;
    totalRevenueUsd?: number;
    anomalies?: { type: string; tenantId?: string; description: string; detectedAt?: string }[];
  };
  retrievedAt: string;
}

export default function OpsBilling() {
  const { data, isLoading } = useQuery<BillingResponse>({
    queryKey: ["/api/admin/platform/billing"],
  });

  const health = data?.health;
  const anomalies = health?.anomalies ?? [];

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-destructive" /> Billing Monitor
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Subscription states, invoices, and billing anomalies
          </p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)
          ) : (
            <>
              {[
                { label: "Total Subs",   value: health?.totalSubscriptions  ?? "—", icon: CreditCard,   testId: "total-subs" },
                { label: "Active Subs",  value: health?.activeSubscriptions ?? "—", icon: CheckCircle,  testId: "active-subs" },
                { label: "Failed Pymt", value: health?.failedPayments       ?? "—", icon: AlertTriangle, testId: "failed-payments" },
                { label: "Revenue",     value: health?.totalRevenueUsd != null ? `$${Number(health.totalRevenueUsd).toFixed(2)}` : "—", icon: DollarSign, testId: "revenue" },
              ].map(({ label, value, icon: Icon, testId }) => (
                <Card key={testId} className="bg-card border-card-border" data-testid={`ops-billing-metric-${testId}`}>
                  <CardContent className="pt-5">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-4 h-4 text-destructive" />
                      <p className="text-xs text-muted-foreground">{label}</p>
                    </div>
                    <p className="text-2xl font-bold" data-testid={`ops-billing-value-${testId}`}>{value}</p>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>

        {/* Health Status */}
        {!isLoading && (
          <Card className={`border ${health?.healthy ? "bg-green-500/5 border-green-500/25" : "bg-destructive/5 border-destructive/25"}`}>
            <CardContent className="py-3 flex items-center gap-2">
              {health?.healthy
                ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                : <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />}
              <p className="text-sm" data-testid="ops-billing-health-msg">
                Billing subsystem is <strong>{health?.healthy ? "healthy" : "degraded"}</strong>
              </p>
            </CardContent>
          </Card>
        )}

        {/* Anomalies */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-secondary" /> Billing Anomalies
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : anomalies.length > 0 ? (
              <div data-testid="ops-billing-anomalies-list">
                {anomalies.map((a, i) => (
                  <div key={i} className="flex items-start justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`ops-billing-anomaly-${i}`}>
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge variant="outline" className="text-xs bg-secondary/15 text-secondary border-secondary/25">{a.type}</Badge>
                        {a.tenantId && <span className="text-xs font-mono text-muted-foreground">{a.tenantId}</span>}
                      </div>
                      <p className="text-xs text-foreground">{a.description}</p>
                    </div>
                    {a.detectedAt && (
                      <span className="text-xs text-muted-foreground shrink-0 ml-3">
                        {new Date(a.detectedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center">
                <CheckCircle className="w-7 h-7 text-green-400/60 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="ops-no-anomalies-msg">No billing anomalies detected</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
