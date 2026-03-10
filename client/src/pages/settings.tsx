import { useQuery } from "@tanstack/react-query";
import { Building2, Shield, Database, GitBranch, CheckCircle, Circle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

interface ConfigStatus {
  supabase: { url: string | null; connected: boolean };
  github: { connected: boolean; owner: string | null; repo: string | null };
  openai: { connected: boolean };
}

function SettingsSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <Card className="bg-card border-card-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-card-foreground">
          <Icon className="w-4 h-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <Separator className="opacity-50" />
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  );
}

function SettingRow({
  label,
  value,
  badge,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  badge?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className={`text-xs text-foreground ${mono ? "font-mono" : ""}`}
          data-testid={`setting-${label.toLowerCase().replace(/\s/g, "-")}`}
        >
          {value}
        </span>
        {badge && (
          <Badge variant="outline" className="text-xs">
            {badge}
          </Badge>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ connected, label }: { connected: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {connected ? (
        <CheckCircle className="w-3.5 h-3.5 text-green-400" />
      ) : (
        <Circle className="w-3.5 h-3.5 text-muted-foreground/30" />
      )}
      <span className={`text-xs ${connected ? "text-green-400" : "text-muted-foreground/60"}`}>
        {connected ? label : "Not configured"}
      </span>
    </div>
  );
}

export default function Settings() {
  const { data: configStatus, isLoading } = useQuery<ConfigStatus>({
    queryKey: ["/api/config/status"],
  });

  return (
    <div className="p-6 space-y-5 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Organisation and platform configuration
        </p>
      </div>

      <SettingsSection title="Organisation" icon={Building2}>
        <div className="divide-y divide-border/50">
          <SettingRow label="Name" value="Demo Organisation" />
          <SettingRow label="Slug" value="demo-org" mono />
          <SettingRow label="Plan" value="V1 Internal" />
          <SettingRow
            label="Auth layer"
            value="Supabase Auth"
            badge="Wired"
          />
        </div>
        <p className="text-xs text-muted-foreground/50 mt-4">
          Full multi-tenant auth is wired via Supabase Auth. Pass a{" "}
          <code className="font-mono bg-muted px-1 rounded">Bearer</code> token to use
          real user identity. Unauthenticated requests use the demo org context.
        </p>
      </SettingsSection>

      <SettingsSection title="Infrastructure" icon={Database}>
        <div className="divide-y divide-border/50">
          <SettingRow label="Database" value="PostgreSQL (Replit)" />
          <SettingRow label="ORM" value="Drizzle ORM" />
          <SettingRow label="Schema" value="17 tables" badge="V1" />
          <SettingRow
            label="Supabase Auth"
            value={
              isLoading ? (
                <Skeleton className="w-24 h-4" />
              ) : (
                <StatusBadge
                  connected={configStatus?.supabase.connected ?? false}
                  label={configStatus?.supabase.url ?? "Connected"}
                />
              )
            }
          />
          <SettingRow label="Multi-tenancy" value="organization_id — top-level entities" />
        </div>
        <p className="text-xs text-muted-foreground/50 mt-4">
          V2 will add knowledge_chunks, knowledge_vectors, and deployment_targets.
        </p>
      </SettingsSection>

      <SettingsSection title="GitHub" icon={GitBranch}>
        <div className="divide-y divide-border/50">
          <SettingRow
            label="Token"
            value={
              isLoading ? (
                <Skeleton className="w-24 h-4" />
              ) : (
                <StatusBadge
                  connected={configStatus?.github.connected ?? false}
                  label="Configured"
                />
              )
            }
          />
          <SettingRow
            label="Default owner"
            value={configStatus?.github.owner ?? "—"}
            mono
          />
          <SettingRow
            label="Default repo"
            value={configStatus?.github.repo ?? "—"}
            mono
          />
        </div>
        <p className="text-xs text-muted-foreground/50 mt-4">
          Set{" "}
          <code className="font-mono bg-muted px-1 rounded">GITHUB_OWNER</code> and{" "}
          <code className="font-mono bg-muted px-1 rounded">GITHUB_REPO</code> as environment
          variables to configure defaults. Projects can override these per-project.
        </p>
      </SettingsSection>

      <SettingsSection title="Security" icon={Shield}>
        <div className="divide-y divide-border/50">
          <SettingRow label="Secrets storage" value="Replit Secrets (env vars)" badge="Secure" />
          <SettingRow label="Client exposure" value="None — all tokens server-side only" />
          <SettingRow label="RLS" value="Scaffolded — policies TODO for production" />
        </div>
        <div className="mt-4 rounded-md bg-primary/5 border border-primary/15 p-3 text-xs text-muted-foreground">
          SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN and OPENAI_API_KEY are loaded via
          environment variables and never returned to the browser.
        </div>
      </SettingsSection>
    </div>
  );
}
