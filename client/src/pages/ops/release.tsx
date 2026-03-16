import { useQuery } from "@tanstack/react-query";
import { OpsNav } from "@/components/ops/OpsNav";
import { MetricCard } from "@/components/ops/MetricCard";
import { StatusPill } from "@/components/ops/StatusPill";
import { RiskBadge } from "@/components/ops/RiskBadge";
import { EnvStatusTable } from "@/components/ops/EnvStatusTable";
import { SchemaStatusTable } from "@/components/ops/SchemaStatusTable";
import { ConfigCheckRow } from "@/components/ops/ConfigCheckRow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, RefreshCw, GitCommit, Clock, Layers, Wifi, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DeployHealthReport {
  status: "healthy" | "warning" | "critical";
  appVersion: string;
  gitCommit: string;
  deployTimestamp: string;
  environment: string;
  envStatus: {
    requiredOk: boolean;
    missingRequired: string[];
    optionalWarnings: string[];
    presentRequired: string[];
    presentOptional: string[];
    checkedAt: string;
  };
  schemaStatus: {
    schemaValid: boolean;
    missingTables: string[];
    missingColumns: string[];
    missingIndexes: string[];
    presentTables: string[];
    presentIndexes: string[];
    checkedAt: string;
  };
  queueStatus: {
    pending: number;
    stalled: number;
    failed24h: number;
  };
  webhookStatus: {
    totalDeliveries24h: number;
    failedDeliveries24h: number;
    failureRate: number;
  };
  backupStatus: {
    healthy: boolean;
    message: string;
    lastVerified: string | null;
  };
  warnings: string[];
  retrievedAt: string;
}

function statusToVariant(
  s: "healthy" | "warning" | "critical",
): "success" | "warning" | "destructive" {
  if (s === "healthy") return "success";
  if (s === "warning") return "warning";
  return "destructive";
}

function checkStatus(ok: boolean, warn = false): "ok" | "warning" | "error" {
  if (ok) return "ok";
  if (warn) return "warning";
  return "error";
}

export default function OpsRelease() {
  const { data, isLoading, isFetching, error, refetch } = useQuery<DeployHealthReport>({
    queryKey: ["/api/admin/platform/deploy-health"],
    refetchInterval: 60_000,
  });

  const shortCommit = data?.gitCommit
    ? data.gitCommit === "local"
      ? "local"
      : data.gitCommit.slice(0, 8)
    : "—";

  return (
    <div className="min-h-screen bg-background" data-testid="release-health-page">
      <OpsNav />

      <div className="px-6 py-6 space-y-6 max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Release Health</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Environment, schema and deploy integrity
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="btn-refresh-deploy-health"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Warnings banner */}
        {data?.warnings && data.warnings.length > 0 && (
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 px-4 py-3 space-y-1" data-testid="warnings-banner">
            <div className="flex items-center gap-2 text-yellow-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span className="text-sm font-medium">{data.warnings.length} issue(s) detected</span>
            </div>
            {data.warnings.map((w, i) => (
              <p key={i} className="text-xs text-yellow-300/80 pl-6" data-testid={`warning-item-${i}`}>{w}</p>
            ))}
          </div>
        )}

        {/* Overall status metric cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)
          ) : (
            <>
              <MetricCard
                title="Deploy Status"
                value={data?.status ?? "—"}
                icon={<Layers className="w-4 h-4" />}
                testId="metric-deploy-status"
              />
              <MetricCard
                title="App Version"
                value={data?.appVersion ?? "—"}
                icon={<GitCommit className="w-4 h-4" />}
                testId="metric-app-version"
              />
              <MetricCard
                title="Git Commit"
                value={shortCommit}
                icon={<GitCommit className="w-4 h-4" />}
                testId="metric-git-commit"
              />
              <MetricCard
                title="Environment"
                value={data?.environment ?? "—"}
                icon={<Clock className="w-4 h-4" />}
                testId="metric-environment"
              />
            </>
          )}
        </div>

        {/* Status pills row */}
        {!isLoading && data && (
          <div className="flex flex-wrap items-center gap-3" data-testid="status-pills-row">
            <StatusPill
              label="Overall Health"
              variant={statusToVariant(data.status)}
              testId="pill-overall-health"
            />
            <StatusPill
              label={`Env: ${data.envStatus.requiredOk ? "OK" : "CRITICAL"}`}
              variant={data.envStatus.requiredOk ? "success" : "destructive"}
              testId="pill-env-status"
            />
            <StatusPill
              label={`Schema: ${data.schemaStatus.schemaValid ? "OK" : "DRIFT"}`}
              variant={data.schemaStatus.schemaValid ? "success" : "destructive"}
              testId="pill-schema-status"
            />
            <StatusPill
              label={`Queue: ${data.queueStatus.stalled > 0 ? "Stalled" : "OK"}`}
              variant={data.queueStatus.stalled > 0 ? "warning" : "success"}
              testId="pill-queue-status"
            />
          </div>
        )}

        {/* Main 2-column grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Environment status */}
          {isLoading ? (
            <Skeleton className="h-80 w-full rounded-lg" />
          ) : data ? (
            <EnvStatusTable
              presentRequired={data.envStatus.presentRequired}
              missingRequired={data.envStatus.missingRequired}
              presentOptional={data.envStatus.presentOptional}
              optionalWarnings={data.envStatus.optionalWarnings}
              testId="env-status-table"
            />
          ) : null}

          {/* Schema status */}
          {isLoading ? (
            <Skeleton className="h-80 w-full rounded-lg" />
          ) : data ? (
            <SchemaStatusTable
              presentTables={data.schemaStatus.presentTables}
              missingTables={data.schemaStatus.missingTables}
              missingColumns={data.schemaStatus.missingColumns}
              presentIndexes={data.schemaStatus.presentIndexes}
              missingIndexes={data.schemaStatus.missingIndexes}
              testId="schema-status-table"
            />
          ) : null}
        </div>

        {/* Runtime checks */}
        <Card data-testid="runtime-checks-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Runtime Checks</CardTitle>
          </CardHeader>
          <CardContent className="p-0 px-4 pb-4 space-y-0">
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full mb-1" />)
            ) : data ? (
              <>
                <ConfigCheckRow
                  label="Job Queue"
                  status={checkStatus(data.queueStatus.stalled === 0, data.queueStatus.stalled > 0)}
                  detail={`${data.queueStatus.pending} pending · ${data.queueStatus.stalled} stalled · ${data.queueStatus.failed24h} failed (24h)`}
                  testId="runtime-queue"
                />
                <ConfigCheckRow
                  label="Webhook Delivery"
                  status={checkStatus(data.webhookStatus.failureRate < 10, data.webhookStatus.failureRate >= 10)}
                  detail={`${data.webhookStatus.totalDeliveries24h} deliveries · ${data.webhookStatus.failureRate}% failure rate (24h)`}
                  testId="runtime-webhooks"
                />
                <ConfigCheckRow
                  label="Backup Status"
                  status={data.backupStatus.healthy ? "ok" : "warning"}
                  detail={data.backupStatus.message}
                  testId="runtime-backup"
                />
              </>
            ) : null}
          </CardContent>
        </Card>

        {/* Deploy metadata */}
        {data && (
          <Card data-testid="deploy-metadata-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Deploy Metadata</CardTitle>
            </CardHeader>
            <CardContent className="p-0 px-4 pb-4 space-y-0">
              <ConfigCheckRow label="App Version"      status="ok" detail={data.appVersion}      testId="meta-version" />
              <ConfigCheckRow label="Git Commit"       status="ok" detail={data.gitCommit}       testId="meta-commit" />
              <ConfigCheckRow label="Deploy Timestamp" status="ok" detail={data.deployTimestamp} testId="meta-deploy-ts" />
              <ConfigCheckRow label="Environment"      status="ok" detail={data.environment}     testId="meta-env" />
              <ConfigCheckRow label="Last Checked"     status="ok" detail={data.retrievedAt}     testId="meta-retrieved" />
            </CardContent>
          </Card>
        )}

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3" data-testid="error-message">
            <p className="text-sm text-red-400">Failed to load deploy health data. {String(error)}</p>
          </div>
        )}
      </div>
    </div>
  );
}
