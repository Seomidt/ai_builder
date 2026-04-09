import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Settings, Globe, Clock, DollarSign, Save, Info, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";

type TenantRetentionMode = "days_30" | "days_90" | "forever";

interface RetentionSettingsResponse {
  defaultRetentionMode: TenantRetentionMode;
}

const RETENTION_OPTIONS: { value: TenantRetentionMode; label: string; description: string }[] = [
  { value: "days_30",  label: "30 dage",    description: "Filer slettes automatisk efter 30 dage" },
  { value: "days_90",  label: "90 dage",    description: "Filer slettes automatisk efter 90 dage" },
  { value: "forever",  label: "Slet aldrig", description: "Filer opbevares permanent" },
];

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

const LANGUAGES = [
  { code: "da", label: "Dansk" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "sv", label: "Svenska" },
  { code: "no", label: "Norsk" },
  { code: "nl", label: "Nederlands" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
];

const TIMEZONES = [
  { code: "Europe/Copenhagen", label: "København (CET)" },
  { code: "Europe/London",     label: "London (GMT)" },
  { code: "UTC",               label: "UTC" },
  { code: "America/New_York",  label: "New York (EST)" },
  { code: "America/Los_Angeles", label: "Los Angeles (PST)" },
  { code: "Asia/Tokyo",        label: "Tokyo (JST)" },
];

const CURRENCIES = [
  { code: "DKK", label: "DKK – Danske kroner" },
  { code: "EUR", label: "EUR – Euro" },
  { code: "USD", label: "USD – US Dollar" },
  { code: "GBP", label: "GBP – Britiske pund" },
  { code: "SEK", label: "SEK – Svenske kroner" },
  { code: "NOK", label: "NOK – Norske kroner" },
];

function SettingRow({ label, icon: Icon, children }: { label: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-border last:border-0">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm text-foreground">{label}</span>
      </div>
      <div className="w-52">{children}</div>
    </div>
  );
}

export default function TenantSettings() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<TenantSettings>({ queryKey: ["/api/tenant/settings"] });

  const { data: retentionData, isLoading: retentionLoading } =
    useQuery<RetentionSettingsResponse>({ queryKey: ["/api/knowledge/settings/retention"] });

  const [form, setForm] = useState({
    language: "da",
    locale: "da-DK",
    currency: "DKK",
    timezone: "Europe/Copenhagen",
  });

  const [retentionMode, setRetentionMode] = useState<TenantRetentionMode>("days_30");

  useEffect(() => {
    if (data?.tenant) {
      setForm({
        language: data.tenant.defaultLanguage ?? "da",
        locale:   data.tenant.defaultLocale   ?? "da-DK",
        currency: data.tenant.currency        ?? "DKK",
        timezone: data.tenant.timezone        ?? "Europe/Copenhagen",
      });
    }
  }, [data]);

  useEffect(() => {
    if (retentionData?.defaultRetentionMode) {
      setRetentionMode(retentionData.defaultRetentionMode);
    }
  }, [retentionData]);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", "/api/tenant/settings", form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/settings"] });
      toast({ title: "Gemt", description: "Indstillinger opdateret" });
    },
    onError: (err: Error) => toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const retentionMutation = useMutation({
    mutationFn: (mode: TenantRetentionMode) =>
      apiRequest("PATCH", "/api/knowledge/settings/retention", { defaultRetentionMode: mode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/settings/retention"] });
      toast({ title: "Gemt", description: "Opbevaringsperiode opdateret" });
    },
    onError: (err: Error) => toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const set = (field: keyof typeof form, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  const handleRetentionChange = (mode: TenantRetentionMode) => {
    setRetentionMode(mode);
    retentionMutation.mutate(mode);
  };

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
              <h1 className="text-xl font-bold text-foreground tracking-tight">Indstillinger</h1>
            </div>
            <p className="text-sm text-muted-foreground ml-10">Organisations- og regionskonfiguration</p>
          </div>
          <Button
            size="sm" className="gap-1.5"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            data-testid="button-save-settings"
          >
            <Save className="w-4 h-4" />
            {saveMutation.isPending ? "Gemmer…" : "Gem ændringer"}
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-48" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          <>
            <Card className="bg-card border-card-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Globe className="w-4 h-4 text-primary" /> Sprog & Region
                </CardTitle>
              </CardHeader>
              <CardContent>
                <SettingRow label="Sprog" icon={Globe}>
                  <Select value={form.language} onValueChange={(v) => set("language", v)}>
                    <SelectTrigger data-testid="select-language"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map((l) => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Valuta" icon={DollarSign}>
                  <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                    <SelectTrigger data-testid="select-currency"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Tidszone" icon={Clock}>
                  <Select value={form.timezone} onValueChange={(v) => set("timezone", v)}>
                    <SelectTrigger data-testid="select-timezone"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((t) => <SelectItem key={t.code} value={t.code}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
              </CardContent>
            </Card>

            <Card className="bg-card border-card-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Info className="w-4 h-4 text-primary" /> AI-konfiguration
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="py-3 space-y-2">
                  <p className="text-sm text-foreground">Smart model-routing er aktivt</p>
                  <p className="text-xs text-muted-foreground">
                    AI-modellen vælges automatisk baseret på opgavens kompleksitet.
                    Simple spørgsmål bruger hurtige modeller, mens komplekse analyser automatisk eskaleres til mere avancerede modeller.
                  </p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">Simpel → GPT-4.1-nano</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">Standard → GPT-4.1-mini</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">Kompleks → GPT-4.1</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card border-card-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Database className="w-4 h-4 text-primary" /> Opbevaringsperiode
                </CardTitle>
              </CardHeader>
              <CardContent>
                {retentionLoading ? (
                  <div className="py-3 space-y-2">
                    <Skeleton className="h-14 w-full" />
                  </div>
                ) : (
                  <div className="py-2 space-y-2">
                    <p className="text-xs text-muted-foreground pb-1">
                      Standard opbevaringsperiode for alle uploadede filer — gælder for både chat-uploads og vidensbase-filer.
                    </p>
                    <div
                      className="grid grid-cols-3 gap-2"
                      role="radiogroup"
                      aria-label="Opbevaringsperiode"
                    >
                      {RETENTION_OPTIONS.map((opt) => {
                        const isSelected = retentionMode === opt.value;
                        return (
                          <button
                            key={opt.value}
                            role="radio"
                            aria-checked={isSelected}
                            data-testid={`retention-option-${opt.value}`}
                            disabled={retentionMutation.isPending}
                            onClick={() => handleRetentionChange(opt.value)}
                            className={[
                              "flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                              isSelected
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                              retentionMutation.isPending ? "opacity-60 cursor-not-allowed" : "cursor-pointer",
                            ].join(" ")}
                          >
                            <span className="text-sm font-medium leading-none">{opt.label}</span>
                            <span className="text-xs leading-snug opacity-75">{opt.description}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
