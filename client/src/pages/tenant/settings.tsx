import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Settings, Globe, Clock, DollarSign, BrainCircuit, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface TenantSettings {
  tenant: {
    defaultLanguage: string;
    defaultLocale: string;
    currency: string;
    timezone: string;
    aiModel: string;
    maxTokensPerRun: number;
  };
  updatedAt: string;
}

const LANGUAGES  = ["en", "da", "de", "fr", "es", "pt", "nl", "sv", "no"];
const TIMEZONES  = ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Copenhagen", "Asia/Tokyo"];
const CURRENCIES = ["USD", "EUR", "GBP", "DKK", "SEK", "NOK"];
const AI_MODELS  = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"];

function SettingRow({ label, icon: Icon, children }: { label: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-border last:border-0">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm text-foreground">{label}</span>
      </div>
      <div className="w-44">{children}</div>
    </div>
  );
}

export default function TenantSettings() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<TenantSettings>({ queryKey: ["/api/tenant/settings"] });

  const [form, setForm] = useState({
    defaultLanguage: "en", defaultLocale: "en-US",
    currency: "USD", timezone: "UTC",
    aiModel: "gpt-4o", maxTokensPerRun: 100_000,
  });

  useEffect(() => {
    if (data?.tenant) setForm(data.tenant);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", "/api/tenant/settings", form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/settings"] });
      toast({ title: "Settings saved", description: "Configuration updated successfully" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const set = (field: keyof typeof form, value: string | number) =>
    setForm((f) => ({ ...f, [field]: value }));

  return (
    <div className="flex flex-col h-full">
      <TenantNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-3xl">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div
                className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
                style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}
              >
                <Settings className="w-4 h-4 text-primary" />
              </div>
              <h1 className="text-xl font-bold text-foreground tracking-tight">Settings</h1>
            </div>
            <p className="text-sm text-muted-foreground ml-10">Tenant and AI configuration</p>
          </div>
          <Button
            size="sm" className="gap-1.5"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            data-testid="button-save-settings"
          >
            <Save className="w-4 h-4" />
            {saveMutation.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-48" />
            <Skeleton className="h-36" />
          </div>
        ) : (
          <>
            {/* Locale Settings */}
            <Card className="bg-card border-card-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Globe className="w-4 h-4 text-primary" /> Locale
                </CardTitle>
              </CardHeader>
              <CardContent>
                <SettingRow label="Language" icon={Globe}>
                  <Select value={form.defaultLanguage} onValueChange={(v) => set("defaultLanguage", v)}>
                    <SelectTrigger data-testid="select-language"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map((l) => <SelectItem key={l} value={l}>{l.toUpperCase()}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Currency" icon={DollarSign}>
                  <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                    <SelectTrigger data-testid="select-currency"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Timezone" icon={Clock}>
                  <Select value={form.timezone} onValueChange={(v) => set("timezone", v)}>
                    <SelectTrigger data-testid="select-timezone"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
              </CardContent>
            </Card>

            {/* AI Configuration */}
            <Card className="bg-card border-card-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-primary" /> AI Configuration
                </CardTitle>
              </CardHeader>
              <CardContent>
                <SettingRow label="Default Model" icon={BrainCircuit}>
                  <Select value={form.aiModel} onValueChange={(v) => set("aiModel", v)}>
                    <SelectTrigger data-testid="select-ai-model"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AI_MODELS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Max Tokens / Run" icon={BrainCircuit}>
                  <Input
                    type="number"
                    value={form.maxTokensPerRun}
                    onChange={(e) => set("maxTokensPerRun", Number(e.target.value))}
                    className="text-sm"
                    data-testid="input-max-tokens"
                  />
                </SettingRow>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
