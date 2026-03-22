import { Clock, Construction } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function OpsJobs() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-jobs-page">
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
            style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}
          >
            <Clock className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-ops-jobs-title">Background Jobs</h1>
        </div>
        <p className="text-sm text-muted-foreground ml-10">Job queue monitoring and execution status</p>
      </div>

      <Card className="bg-card border-card-border" data-testid="ops-jobs-deferred-card">
        <CardContent className="py-12 flex flex-col items-center gap-3">
          <Construction className="w-10 h-10 text-muted-foreground/40" />
          <Badge variant="outline" className="text-xs" data-testid="jobs-deferred-badge">Intentionally deferred</Badge>
          <p className="text-sm font-medium text-foreground" data-testid="jobs-deferred-title">Job Queue Not Yet Enabled</p>
          <p className="text-xs text-muted-foreground text-center max-w-sm" data-testid="jobs-deferred-desc">
            Background job infrastructure is not yet wired to a backend queue.
            This page will be enabled when a job runner (e.g. Inngest, BullMQ, or Trigger.dev) is integrated.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
