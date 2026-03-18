import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Webhook, AlertTriangle, CheckCircle, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OpsNav } from "@/components/ops/OpsNav";
import { MetricCard } from "@/components/ops/MetricCard";
import { TimeRangeFilter, TIME_RANGE_OPTIONS } from "@/components/ops/TimeRangeFilter";
import { TrendChart } from "@/components/ops/TrendChart";
import { TopList } from "@/components/ops/TopList";

interface WebhooksResponse {
  summary: {
    jobs: {
      total: number; pending: number; running: number; completed: number;
      failed: number; stalled: number; failureRate: number; queueBacklog: number;
    };
    webhooks: {
      total: number; delivered: number; failed: number; pending: number;
      deliveryRate: number; avgAttemptsOnFail: number;
    };
    topFailingJobTypes: { jobType: string; failed: number; total: number }[];
    topFailingEndpoints: { endpointId: string; failed: number; total: number }[];
    windowHours: number;
  };
  explanation: { summary: string; issues: string[]; recommendations: string[] };
}

interface TrendResponse {
  trend: {
    points: {
      bucket: string; jobsCreated: number; jobsFailed: number;
      webhooksDelivered: number; webhooksFailed: number;
    }[];
  };
}

export default function WebhooksDashboard() {
  const [windowHours, setWindowHours] = useState("24");

  const { data, isLoading } = useQuery<WebhooksResponse>({
    queryKey: ["/api/admin/analytics/jobs-webhooks", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/jobs-webhooks?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 60000,
  });

  const { data: trendData, isLoading: trendLoading } = useQuery<TrendResponse>({
    queryKey: ["/api/admin/analytics/jobs-webhooks/trend", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/jobs-webhooks/trend?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 60000,
  });

  const s  = data?.summary;
  const ex = data?.explanation;
  const trendPoints = trendData?.trend?.points ?? [];

  const deliveryRate = s?.webhooks.deliveryRate ?? 100;
  const rateColor = deliveryRate >= 99 ? "text-green-400"
    : deliveryRate >= 95 ? "text-yellow-400" : "text-red-400";

  return (
    <div className="flex min-h-screen bg-background">
      <OpsNav />
      <main className="flex-1 p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2" data-testid="page-title">
              <Webhook className="w-5 h-5 text-destructive" /> Webhook Monitoring
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Delivery success, failures, retries and endpoint reliability
            </p>
          </div>
          <TimeRangeFilter value={windowHours} onChange={setWindowHours}
            options={TIME_RANGE_OPTIONS as unknown as { label: string; value: string }[]} />
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

        {!isLoading && s && s.webhooks.failed === 0 && (
          <Card className="border-green-500/30 bg-green-500/5" data-testid="healthy-state">
            <CardContent className="pt-4 flex items-center gap-2 text-sm text-green-400">
              <CheckCircle className="w-4 h-4" /> All webhook deliveries successful in this window
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Total Deliveries" value={s?.webhooks.total     ?? 0} icon={Webhook}
            testId="metric-total-deliveries" loading={isLoading} />
          <MetricCard label="Delivered"        value={s?.webhooks.delivered ?? 0} icon={CheckCircle}
            colorClass="text-green-400" testId="metric-delivered" loading={isLoading} />
          <MetricCard label="Failed"           value={s?.webhooks.failed    ?? 0} icon={AlertTriangle}
            colorClass={s && s.webhooks.failed > 0 ? "text-red-400" : "text-green-400"}
            testId="metric-failed-webhooks" loading={isLoading} />
          <MetricCard label="Pending"          value={s?.webhooks.pending   ?? 0} icon={Activity}
            testId="metric-pending-webhooks" loading={isLoading} />
          <MetricCard label="Delivery Rate"    value={s ? `${deliveryRate}%` : "—"} icon={Activity}
            colorClass={rateColor}
            subtext={`Avg ${s?.webhooks.avgAttemptsOnFail ?? 0} attempts on fail`}
            testId="metric-delivery-rate" loading={isLoading} />
        </div>

        {!isLoading && s && (
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Delivery Success Rate</span>
                <span className={`text-lg font-bold ${rateColor}`} data-testid="delivery-rate-value">
                  {deliveryRate.toFixed(1)}%
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${deliveryRate >= 99 ? "bg-green-500" : deliveryRate >= 95 ? "bg-yellow-500" : "bg-red-500"}`}
                  style={{ width: `${Math.min(100, deliveryRate)}%` }}
                  data-testid="delivery-rate-bar"
                />
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TrendChart
            title="Webhook Delivery Trend"
            points={trendPoints}
            series={[
              { key: "webhooksDelivered", label: "Delivered", color: "#22c55e" },
              { key: "webhooksFailed",    label: "Failed",    color: "#ef4444" },
            ]}
            loading={trendLoading}
            testId="chart-webhook-trend"
          />
          <TopList
            title="Top Failing Endpoints"
            loading={isLoading}
            testId="list-failing-endpoints"
            emptyText="No endpoint failures in window"
            items={(s?.topFailingEndpoints ?? []).map(ep => ({
              id: ep.endpointId,
              label: ep.endpointId,
              value: `${ep.failed} failed`,
              subvalue: `out of ${ep.total} deliveries`,
            }))}
          />
        </div>
      </main>
    </div>
  );
}
