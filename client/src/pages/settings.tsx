import { Building2, Shield, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

function SettingsSection({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
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

function SettingRow({ label, value, badge }: { label: string; value: string; badge?: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-foreground font-mono" data-testid={`setting-${label.toLowerCase().replace(/\s/g,"-")}`}>{value}</span>
        {badge && <Badge variant="outline" className="text-xs">{badge}</Badge>}
      </div>
    </div>
  );
}

export default function Settings() {
  return (
    <div className="p-6 space-y-5 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Organization and platform configuration</p>
      </div>

      <SettingsSection title="Organisation" icon={Building2}>
        <div className="space-y-0 divide-y divide-border/50">
          <SettingRow label="Name" value="Demo Organisation" />
          <SettingRow label="Slug" value="demo-org" />
          <SettingRow label="Organisation ID" value="demo-org" badge="Default" />
          <SettingRow label="Plan" value="V1 Internal" />
        </div>
        <p className="text-xs text-muted-foreground/50 mt-4">
          Multi-tenant support is fully wired. To use real organisations, connect Supabase Auth and pass{" "}
          <code className="font-mono bg-muted px-1 rounded">x-organization-id</code> headers.
        </p>
      </SettingsSection>

      <SettingsSection title="Security" icon={Shield}>
        <div className="space-y-0 divide-y divide-border/50">
          <SettingRow label="Authentication" value="Supabase Auth (ready)" badge="V1" />
          <SettingRow label="Row Level Security" value="Scaffolded (TODO: policies)" />
          <SettingRow label="Secrets" value="Server-side only" badge="Secure" />
        </div>
        <div className="mt-4 rounded-md bg-primary/5 border border-primary/15 p-3 text-xs text-muted-foreground">
          All provider tokens (GitHub, OpenAI) must be set as environment variables. They are never stored in the database or exposed to the client.
        </div>
      </SettingsSection>

      <SettingsSection title="Database" icon={Database}>
        <div className="space-y-0 divide-y divide-border/50">
          <SettingRow label="Provider" value="PostgreSQL (Replit)" />
          <SettingRow label="ORM" value="Drizzle ORM" />
          <SettingRow label="Schema" value="17 tables" badge="V1" />
          <SettingRow label="Multi-tenancy" value="organization_id on all top-level entities" />
        </div>
        <p className="text-xs text-muted-foreground/50 mt-4">
          V2 will add knowledge_chunks, knowledge_vectors, and deployment_targets tables.
        </p>
      </SettingsSection>
    </div>
  );
}
