import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, TrendingUp, AlertTriangle, CheckCircle, DollarSign, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OpsNav } from "@/components/ops/OpsNav";
import { MetricCard } from "@/components/ops/MetricCard";
import { TimeRangeFilter, BILLING_TIME_RANGE_OPTIONS } from "@/components/ops/TimeRangeFilter";
import { TrendChart } from "@/components/ops/TrendChart";
import { TopList } from "@/components/ops/TopList";

interface BillingResponse {
  summary: {
    tenants: { total: number; active: number; trial: number; suspended: number; deleted: number };
    subscriptions: { active: number; canceled: number; pastDue: number };
    invoices: { total: number; finalized: number; draft: number; totalRevenue: number; avgInvoiceValue: number };
    payments: { total: number; succeeded: number; failed: number; successRate: number };
    mrrEstimateUsd: number;
    topRevenueByTenant: { tenantId: string; totalUsd: number }[];
    windowHours: number;
  };
  explanation: { summary: string; issues: string[]; recommendations: string[] };
}

interface TrendResponse {
  trend: {
    points: { bucket: string; newTenants: number; newInvoices: number; revenueUsd: number }[];
  };
}

export default function BillingDashboard() {
  const [windowHours, setWindowHours] = useState("720");

  const { data, isLoading } = useQuery<BillingResponse>({
    queryKey: ["/api/admin/analytics/business-billing", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/business-billing?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 300000,
  });

  const { data: trendData, isLoading: trendLoading } = useQuery<TrendResponse>({
    queryKey: ["/api/admin/analytics/business-billing/trend", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/business-billing/trend?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 300000,
  });

  const s  = data?.summary;
  const ex = data?.explanation;
  const trendPoints = trendData?.trend?.points ?? [];

  return (
    <div className="flex min-h-screen bg-background">
      <OpsNav />
      <main className="flex-1 p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2" data-testid="page-title">
              <CreditCard className="w-5 h-5 text-destructive" /> Business & Billing
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Revenue, subscriptions, invoices and payment health
            </p>
          </div>
          <TimeRangeFilter value={windowHours} onChange={setWindowHours}
            options={BILLING_TIME_RANGE_OPTIONS as unknown as { label: string; value: string }[]} />
        </div>

        {ex && ex.issues.length > 0 && (
          <Card className="border-yellow-500/30 bg-yellow-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400" /> Issues ({ex.issues.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {ex.issues.map((iss, i) => (
                <p key={i} className="text-sm text-yellow-300" data-testid={`issue-${i}`}>{iss}</p>
              ))}
            </CardContent>
          </Card>
        )}

        {!isLoading && s && s.subscriptions.pastDue === 0 && s.payments.successRate >= 99 && (
          <Card className="border-green-500/30 bg-green-500/5" data-testid="healthy-state">
            <CardContent className="pt-4 flex items-center gap-2 text-sm text-green-400">
              <CheckCircle className="w-4 h-4" /> Billing health is nominal — no past-due subscriptions
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="MRR Estimate"     value={`$${s?.mrrEstimateUsd.toFixed(2) ?? "—"}`} icon={TrendingUp}
            colorClass="text-green-400"
            subtext="Estimated monthly recurring revenue"
            testId="metric-mrr" loading={isLoading} />
          <MetricCard label="Active Tenants"   value={s?.tenants.active  ?? 0} icon={Users}
            colorClass="text-green-400" testId="metric-active-tenants" loading={isLoading} />
          <MetricCard label="Trial Tenants"    value={s?.tenants.trial   ?? 0} icon={Users}
            colorClass="text-blue-400" testId="metric-trial-tenants" loading={isLoading} />
          <MetricCard label="Subscriptions"    value={s?.subscriptions.active ?? 0} icon={CreditCard}
            subtext={`${s?.subscriptions.pastDue ?? 0} past-due`}
            colorClass={s && s.subscriptions.pastDue > 0 ? "text-orange-400" : "text-green-400"}
            testId="metric-subscriptions" loading={isLoading} />
          <MetricCard label="Invoice Revenue"  value={`$${s?.invoices.totalRevenue.toFixed(2) ?? "—"}`} icon={DollarSign}
            subtext={`${s?.invoices.finalized ?? 0} finalized invoices`}
            testId="metric-invoice-revenue" loading={isLoading} />
          <MetricCard label="Payment Success"  value={s ? `${s.payments.successRate}%` : "—"} icon={CheckCircle}
            colorClass={s && s.payments.successRate < 90 ? "text-red-400" : "text-green-400"}
            subtext={`${s?.payments.failed ?? 0} failed`}
            testId="metric-payment-success" loading={isLoading} />
          <MetricCard label="Canceled Subs"    value={s?.subscriptions.canceled ?? 0} icon={AlertTriangle}
            colorClass={s && s.subscriptions.canceled > 0 ? "text-orange-400" : ""}
            testId="metric-canceled-subs" loading={isLoading} />
          <MetricCard label="Suspended"        value={s?.tenants.suspended ?? 0} icon={AlertTriangle}
            colorClass={s && s.tenants.suspended > 0 ? "text-red-400" : ""}
            testId="metric-suspended-tenants" loading={isLoading} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TrendChart
            title="Revenue Over Time"
            points={trendPoints}
            series={[
              { key: "revenueUsd",  label: "Revenue (USD)", color: "#22c55e" },
            ]}
            loading={trendLoading}
            testId="chart-revenue-trend"
          />
          <TrendChart
            title="New Tenants & Invoices Over Time"
            points={trendPoints}
            series={[
              { key: "newTenants",  label: "New Tenants",  color: "#6366f1" },
              { key: "newInvoices", label: "New Invoices", color: "#f97316" },
            ]}
            loading={trendLoading}
            testId="chart-tenants-invoices-trend"
          />
        </div>

        <TopList
          title="Top Revenue Tenants"
          loading={isLoading}
          testId="list-top-revenue"
          emptyText="No revenue data in window"
          items={(s?.topRevenueByTenant ?? []).map(t => ({
            id: t.tenantId,
            label: t.tenantId,
            value: `$${t.totalUsd.toFixed(2)}`,
          }))}
        />

        {ex && ex.recommendations.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Recommendations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {ex.recommendations.map((r, i) => (
                <p key={i} className="text-sm text-muted-foreground" data-testid={`rec-${i}`}>• {r}</p>
              ))}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
