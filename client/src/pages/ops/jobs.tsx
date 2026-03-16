import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cpu, AlertTriangle, CheckCircle, Clock, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OpsNav } from "@/components/ops/OpsNav";
import { MetricCard } from "@/components/ops/MetricCard";
import { TimeRangeFilter, TIME_RANGE_OPTIONS } from "@/components/ops/TimeRangeFilter";
import { TrendChart } from "@/components/ops/TrendChart";
import { TopList } from "@/components/ops/TopList";

interface JobsResponse {
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

export default function JobsDashboard() {
  const [windowHours, setWindowHours] = useState("24");

  const { data, isLoading } = useQuery<JobsResponse>({
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

  return (
    <div className="flex min-h-screen bg-background">
      <OpsNav />
      <main className="flex-1 p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2" data-testid="page-title">
              <Cpu className="w-5 h-5 text-destructive" /> Jobs Monitor
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Job execution reliability, queue health and failure analysis
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

        {!isLoading && s?.jobs.stalled === 0 && s?.jobs.failed === 0 && (
          <Card className="border-green-500/30 bg-green-500/5" data-testid="healthy-state">
            <CardContent className="pt-4 flex items-center gap-2 text-sm text-green-400">
              <CheckCircle className="w-4 h-4" /> Job queue is healthy — no stalled or failed jobs
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Total Jobs"     value={s?.jobs.total     ?? 0} icon={Cpu}
            testId="metric-total-jobs" loading={isLoading} />
          <MetricCard label="Failed"         value={s?.jobs.failed    ?? 0} icon={AlertTriangle}
            colorClass={s && s.jobs.failed > 0 ? "text-red-400" : "text-green-400"}
            testId="metric-failed-jobs" loading={isLoading} />
          <MetricCard label="Stalled"        value={s?.jobs.stalled   ?? 0} icon={Clock}
            colorClass={s && s.jobs.stalled > 0 ? "text-orange-400" : "text-green-400"}
            testId="metric-stalled-jobs" loading={isLoading} />
          <MetricCard label="Queue Backlog"  value={s?.jobs.queueBacklog ?? 0} icon={Zap}
            subtext="Pending + running"
            testId="metric-queue-backlog" loading={isLoading} />
          <MetricCard label="Failure Rate"   value={s ? `${s.jobs.failureRate}%` : "—"} icon={AlertTriangle}
            colorClass={s && s.jobs.failureRate > 10 ? "text-red-400" : "text-green-400"}
            testId="metric-failure-rate" loading={isLoading} />
          <MetricCard label="Completed"      value={s?.jobs.completed ?? 0} icon={CheckCircle}
            colorClass="text-green-400"
            testId="metric-completed-jobs" loading={isLoading} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TrendChart
            title="Job Throughput Over Time"
            points={trendPoints}
            series={[
              { key: "jobsCreated", label: "Created",    color: "#6366f1" },
              { key: "jobsFailed",  label: "Failed",     color: "#ef4444" },
            ]}
            loading={trendLoading}
            testId="chart-job-trend"
          />
          <TopList
            title="Top Failing Job Types"
            loading={isLoading}
            testId="list-failing-job-types"
            emptyText="No job failures in window"
            items={(s?.topFailingJobTypes ?? []).map(jt => ({
              id: jt.jobType,
              label: jt.jobType,
              value: `${jt.failed} failed`,
              subvalue: `out of ${jt.total} total`,
            }))}
          />
        </div>
      </main>
    </div>
  );
}
