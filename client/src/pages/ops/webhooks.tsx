import { Webhook, Construction } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function OpsWebhooks() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-webhooks-page">
      <div>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2" data-testid="text-ops-webhooks-title">
          <Webhook className="w-5 h-5 text-primary" /> Webhook Delivery
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">Outbound webhook endpoints and delivery monitoring</p>
      </div>

      <Card className="bg-card border-card-border" data-testid="ops-webhooks-deferred-card">
        <CardContent className="py-12 flex flex-col items-center gap-3">
          <Construction className="w-10 h-10 text-muted-foreground/40" />
          <Badge variant="outline" className="text-xs" data-testid="webhooks-deferred-badge">Intentionally deferred</Badge>
          <p className="text-sm font-medium text-foreground" data-testid="webhooks-deferred-title">Webhook System Not Yet Enabled</p>
          <p className="text-xs text-muted-foreground text-center max-w-sm" data-testid="webhooks-deferred-desc">
            No webhook infrastructure exists yet in the backend.
            This page will be enabled when outbound webhook delivery is implemented.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
