import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { QUERY_POLICY } from "@/lib/query-policy";
import { apiRequest } from "@/lib/queryClient";
import { friendlyError } from "@/lib/friendlyError";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, CheckCircle, Info, Zap, RefreshCw, Shield } from "lucide-react";

const INTENT_LABELS: Record<string, string> = {
  platform_health_summary: "Platform Health Summary",
  tenant_usage_summary: "Tenant Usage Summary",
  ai_cost_summary: "AI Cost Summary",
  anomaly_explanation: "Anomaly Explanation",
  billing_health_summary: "Billing Health Summary",
  retention_summary: "Retention Summary",
  support_debug_summary: "Support Debug Summary",
  security_summary: "Security Summary",
  storage_health_summary: "Storage Health Summary",
  weekly_ops_digest: "Weekly Ops Digest",
};

const TENANT_REQUIRED_INTENTS = ["tenant_usage_summary", "support_debug_summary"];

type Severity = "info" | "warning" | "critical" | "ok";
type Priority = "low" | "medium" | "high" | "critical";

interface Finding {
  area: string;
  observation: string;
  severity: Severity;
  metric?: string;
  value?: string | number;
}

interface Risk {
  risk: string;
  likelihood: string;
  impact: string;
  mitigation?: string;
}

interface RecommendedAction {
  action: string;
  priority: Priority;
  owner?: string;
  rationale: string;
}

interface OpsResponse {
  intent: string;
  scope: string;
  organizationId: string | null;
  summary: string;
  findings: Finding[];
  risks: Risk[];
  recommendedActions: RecommendedAction[];
  confidence: "high" | "medium" | "low" | "insufficient_data";
  dataFreshness: string;
  sourcesUsed: string[];
  generatedAt: string;
  [key: string]: unknown;
}

interface DigestData {
  weekStart: string;
  weekEnd: string;
  highlights: string[];
  riskSignals: string[];
  platformHealth: { systemStatus: string; recentAnomalyCount: number; totalEventsLast7d: number };
  aiCost: { totalSnapshotCostUsd: number; recentAlertCount: number };
  billing: { activeSubscriptions: number; overdueInvoices: number };
  security: { totalEvents: number; criticalCount: number };
}

function severityIcon(severity: Severity) {
  if (severity === "critical") return <AlertTriangle className="h-4 w-4 text-red-500" />;
  if (severity === "warning") return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
  if (severity === "ok") return <CheckCircle className="h-4 w-4 text-green-500" />;
  return <Info className="h-4 w-4 text-blue-500" />;
}

function priorityBadge(priority: Priority) {
  const colors: Record<Priority, string> = {
    critical: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    high: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    low: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  };
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${colors[priority]}`}>
      {priority.toUpperCase()}
    </span>
  );
}

function confidenceBadge(confidence: string) {
  if (confidence === "high") return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">High confidence</Badge>;
  if (confidence === "medium") return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">Medium confidence</Badge>;
  if (confidence === "low") return <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">Low confidence</Badge>;
  return <Badge variant="outline">Insufficient data</Badge>;
}

export default function OpsAssistant() {
  const [selectedIntent, setSelectedIntent] = useState("platform_health_summary");
  const [tenantId, setTenantId] = useState("");
  const [queryResult, setQueryResult] = useState<OpsResponse | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const { data: digestData, isLoading: digestLoading, refetch: refetchDigest } = useQuery<{ data: DigestData }>({
    queryKey: ["/api/admin/ai-ops/weekly-digest"],
    ...QUERY_POLICY.opsSnapshot,
  });

  const queryMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { intent: selectedIntent };
      if (TENANT_REQUIRED_INTENTS.includes(selectedIntent) && tenantId) {
        body.tenantId = tenantId;
        body.organizationId = tenantId;
      }
      const res = await apiRequest("POST", "/api/admin/ai-ops/query", body);
      return res.json() as Promise<{ data: OpsResponse; error?: string }>;
    },
    onSuccess: (result) => {
      if (result.error) {
        // Sanitize server-side error strings — never render raw provider text
        const raw = result.error as string;
        const isProviderErr = /api.?key|unauthorized|401|openai|anthropic|gemini/i.test(raw);
        setQueryError(
          isProviderErr
            ? "AI provider is not configured. Set the required API key in platform secrets."
            : (raw.length < 300 ? raw : "Operations query failed. Please try again."),
        );
        setQueryResult(null);
      } else {
        setQueryResult(result.data);
        setQueryError(null);
      }
    },
    onError: (err: Error) => {
      setQueryError(friendlyError(err));
      setQueryResult(null);
    },
  });

  const digest = digestData?.data;
  const needsTenant = TENANT_REQUIRED_INTENTS.includes(selectedIntent);

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Shield className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">AI Ops Assistant</h1>
          <p className="text-sm text-muted-foreground">
            Admin-only · Structured operational intelligence · Advisory only
          </p>
        </div>
      </div>

      {/* Weekly Digest */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-semibold">Weekly Ops Digest</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            data-testid="button-refresh-digest"
            onClick={() => refetchDigest()}
            disabled={digestLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${digestLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {digestLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : digest ? (
            <div className="space-y-4">
              <div className="text-xs text-muted-foreground" data-testid="text-digest-period">
                Period: {digest.weekStart} → {digest.weekEnd}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-lg border p-3 text-center" data-testid="card-digest-health">
                  <div className="text-xs text-muted-foreground mb-1">Platform</div>
                  <div className="font-semibold text-sm capitalize">{digest.platformHealth?.systemStatus ?? "—"}</div>
                </div>
                <div className="rounded-lg border p-3 text-center" data-testid="card-digest-cost">
                  <div className="text-xs text-muted-foreground mb-1">AI Cost</div>
                  <div className="font-semibold text-sm">${(digest.aiCost?.totalSnapshotCostUsd ?? 0).toFixed(2)}</div>
                </div>
                <div className="rounded-lg border p-3 text-center" data-testid="card-digest-subs">
                  <div className="text-xs text-muted-foreground mb-1">Active Subs</div>
                  <div className="font-semibold text-sm">{digest.billing?.activeSubscriptions ?? 0}</div>
                </div>
                <div className="rounded-lg border p-3 text-center" data-testid="card-digest-security">
                  <div className="text-xs text-muted-foreground mb-1">Security Events</div>
                  <div className="font-semibold text-sm">{digest.security?.totalEvents ?? 0}</div>
                </div>
              </div>
              {digest.riskSignals?.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Risk Signals</div>
                  {digest.riskSignals.map((s, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm text-orange-700 dark:text-orange-400" data-testid={`text-risk-signal-${i}`}>
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      {s}
                    </div>
                  ))}
                </div>
              )}
              {digest.highlights?.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Highlights</div>
                  {digest.highlights.map((h, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm" data-testid={`text-highlight-${i}`}>
                      <Info className="h-3.5 w-3.5 mt-0.5 text-blue-500 shrink-0" />
                      {h}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No digest available.</p>
          )}
        </CardContent>
      </Card>

      {/* Intent Query Panel */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Ops Intelligence Query</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Select
              value={selectedIntent}
              onValueChange={setSelectedIntent}
            >
              <SelectTrigger className="flex-1" data-testid="select-intent">
                <SelectValue placeholder="Select intent" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(INTENT_LABELS).map(([id, label]) => (
                  <SelectItem key={id} value={id} data-testid={`option-intent-${id}`}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {needsTenant && (
              <Input
                placeholder="Tenant / Org ID (required)"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="flex-1"
                data-testid="input-tenant-id"
              />
            )}

            <Button
              onClick={() => queryMutation.mutate()}
              disabled={queryMutation.isPending || (needsTenant && !tenantId)}
              data-testid="button-run-query"
            >
              <Zap className="h-4 w-4 mr-1.5" />
              {queryMutation.isPending ? "Analyzing…" : "Run"}
            </Button>
          </div>

          {needsTenant && (
            <p className="text-xs text-muted-foreground">
              This intent requires a Tenant / Organization ID.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Query Error */}
      {queryError && (
        <Alert variant="destructive" data-testid="alert-query-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{queryError}</AlertDescription>
        </Alert>
      )}

      {/* Query Loading Skeleton */}
      {queryMutation.isPending && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/5" />
          </CardContent>
        </Card>
      )}

      {/* Query Result */}
      {queryResult && !queryMutation.isPending && (
        <Card data-testid="card-query-result">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base font-semibold">
                  {INTENT_LABELS[queryResult.intent] ?? queryResult.intent}
                </CardTitle>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  <span>Scope: <span className="font-medium capitalize">{queryResult.scope}</span></span>
                  {queryResult.organizationId && (
                    <span>· Org: <span className="font-medium">{queryResult.organizationId}</span></span>
                  )}
                  <span>· Freshness: {new Date(queryResult.dataFreshness).toLocaleTimeString()}</span>
                </div>
              </div>
              {confidenceBadge(queryResult.confidence)}
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm leading-relaxed" data-testid="text-summary">{queryResult.summary}</p>

            {queryResult.findings?.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Findings</div>
                <div className="space-y-2">
                  {queryResult.findings.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-md border p-3" data-testid={`card-finding-${i}`}>
                      {severityIcon(f.severity)}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{f.area}</div>
                        <div className="text-sm text-muted-foreground">{f.observation}</div>
                        {f.metric && f.value !== undefined && (
                          <div className="text-xs text-muted-foreground mt-0.5">{f.metric}: {f.value}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {queryResult.risks?.length > 0 && (
              <div>
                <Separator className="mb-3" />
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Risks</div>
                <div className="space-y-2">
                  {queryResult.risks.map((r, i) => (
                    <div key={i} className="rounded-md border border-orange-200 dark:border-orange-900 p-3" data-testid={`card-risk-${i}`}>
                      <div className="font-medium text-sm">{r.risk}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Likelihood: {r.likelihood} · Impact: {r.impact}
                      </div>
                      {r.mitigation && <div className="text-xs text-muted-foreground mt-1">Mitigation: {r.mitigation}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {queryResult.recommendedActions?.length > 0 && (
              <div>
                <Separator className="mb-3" />
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Recommended Actions</div>
                <div className="space-y-2">
                  {queryResult.recommendedActions.map((a, i) => (
                    <div key={i} className="flex items-start gap-3 rounded-md border p-3" data-testid={`card-action-${i}`}>
                      <div className="mt-0.5">{priorityBadge(a.priority)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{a.action}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{a.rationale}</div>
                        {a.owner && <div className="text-xs text-muted-foreground">Owner: {a.owner}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground pt-1 border-t">
              Sources: {queryResult.sourcesUsed?.join(", ") ?? "—"} · Generated: {new Date(queryResult.generatedAt).toLocaleString()}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
