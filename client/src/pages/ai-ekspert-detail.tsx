/**
 * AI Ekspert Detaljeside — /ai-eksperter/:id
 *
 * 6 faner:
 *  1. Overblik     — identitet, status, version-badges
 *  2. Instruktioner — mål, instruktioner, outputstil, eskalering
 *  3. Regler        — list, opret, rediger, slet regler
 *  4. Datakilder    — list, tilknyt, fjern datakilder
 *  5. Test          — test kladde / live version, vis svar + metadata
 *  6. Historik      — versionshistorik
 *
 * Model/provider er IKKE vist som tenant-valg — kun som read-only observability i test-svar.
 */

import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Brain, Shield, Scale, Database, PlayCircle, History,
  Settings, Plus, Trash2, Edit2, CheckCircle2, Clock, AlertTriangle, ShieldCheck, ShieldAlert,
  Loader2, Sparkles, X, ChevronDown, ChevronUp, Info,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { friendlyError } from "@/lib/friendlyError";
import { useToast } from "@/hooks/use-toast";
import { QUERY_POLICY } from "@/lib/query-policy";
import { invalidate } from "@/lib/invalidations";
import { usePagePerf } from "@/lib/perf";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExpertDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  description: string | null;
  goal: string | null;
  instructions: string | null;
  outputStyle: string | null;
  departmentId: string | null;
  language: string | null;
  currentVersionId: string | null;
  draftVersionId: string | null;
  rule_count: number;
  source_count: number;
  live_config: unknown;
  draft_config: unknown;
  createdAt: string;
  updatedAt: string;
}

interface RuleRow {
  id: string;
  type: string;
  name: string;
  description: string | null;
  priority: number;
  enforcementLevel: string;
  status: string;
  config: unknown;
  createdAt: string;
}

interface SourceRow {
  id: string;
  sourceName: string;
  sourceType: string;
  status: string;
  processingNotes: string | null;
  chunksCount: number | null;
  linkedAt: string;
}

interface VersionRow {
  id: string;
  versionNumber: number;
  status: string;
  createdAt: string;
  createdBy: string | null;
}

interface TestResult {
  output:              string;
  used_rules:          Array<{ id: string; name: string; type: string; enforcement_level: string }>;
  used_sources:        Array<{ id: string; name: string; source_type: string; status: string; retrieval_type?: string; relevance_score?: number }>;
  warnings:            string[];
  latency_ms:          number;
  version_tested?:     string;
  provider:            string;
  model_name:          string;
  retrieved_chunks?:   number;
  retrieval_strategy?: string | null;
  retrieval_latency_ms?: number | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RULE_TYPE_LABELS: Record<string, string> = {
  decision:           "Beslutningsregel",
  threshold:          "Tærskelregel",
  required_evidence:  "Dokumentationskrav",
  source_restriction: "Kildebegrænsning",
  escalation:         "Eskalering",
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  document: "Dokument",
  policy:   "Politikdokument",
  legal:    "Juridisk dokument",
  rulebook: "Regelhåndbog",
  image:    "Billede",
  other:    "Andet",
};

const STATUS_LIFECYCLE: Record<string, { label: string; color: string }> = {
  pending:   { label: "Afventer",     color: "text-amber-400 border-amber-500/30 bg-amber-500/5" },
  processed: { label: "Behandlet",    color: "text-blue-400 border-blue-500/30 bg-blue-500/5" },
  failed:    { label: "Fejlet",       color: "text-red-400 border-red-500/30 bg-red-500/5" },
  linked:    { label: "Tilknyttet",   color: "text-green-400 border-green-500/30 bg-green-500/5" },
};

const OUTPUT_STYLE_OPTIONS = [
  { value: "advisory", label: "Rådgivende" },
  { value: "formal",   label: "Formel" },
  { value: "concise",  label: "Præcis/kort" },
];

const LANGUAGE_OPTIONS = [
  { value: "da", label: "Dansk" },
  { value: "en", label: "Engelsk" },
  { value: "de", label: "Tysk" },
  { value: "sv", label: "Svensk" },
  { value: "no", label: "Norsk" },
];

const RULE_TYPE_COLORS: Record<string, string> = {
  decision:           "text-amber-400 border-amber-500/30 bg-amber-500/5",
  threshold:          "text-blue-400 border-blue-500/30 bg-blue-500/5",
  required_evidence:  "text-green-400 border-green-500/30 bg-green-500/5",
  source_restriction: "text-rose-400 border-rose-500/30 bg-rose-500/5",
  escalation:         "text-purple-400 border-purple-500/30 bg-purple-500/5",
};

// ─── Fane-navigation ──────────────────────────────────────────────────────────

type Tab = "overblik" | "instruktioner" | "regler" | "datakilder" | "test" | "historik";

const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "overblik",      label: "Overblik",     icon: Brain       },
  { id: "instruktioner", label: "Instruktioner", icon: Settings    },
  { id: "regler",        label: "Regler",        icon: Scale       },
  { id: "datakilder",    label: "Datakilder",    icon: Database    },
  { id: "test",          label: "Test",          icon: PlayCircle  },
  { id: "historik",      label: "Historik",      icon: History     },
];

// ─── Overblik ─────────────────────────────────────────────────────────────────

function TabOverblik({ expert }: { expert: ExpertDetail }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Status" value={
          <Badge variant="outline" className={`text-xs ${
            expert.status === "active"
              ? "text-green-400 border-green-500/30 bg-green-500/10"
              : "text-muted-foreground"
          }`}>
            {expert.status === "active" ? "Aktiv" : expert.status === "archived" ? "Arkiveret" : expert.status}
          </Badge>
        } />
        <StatCard label="Regler" value={<span className="text-lg font-bold text-foreground">{expert.rule_count}</span>} />
        <StatCard label="Datakilder" value={<span className="text-lg font-bold text-foreground">{expert.source_count}</span>} />
        <StatCard label="Sprog" value={<span className="text-sm text-foreground">{expert.language?.toUpperCase() ?? "DA"}</span>} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <InfoCard label="Live version" value={
          expert.currentVersionId
            ? <Badge variant="outline" className="text-xs text-green-400 border-green-500/30">{expert.currentVersionId.slice(0,8)}…</Badge>
            : <span className="text-xs text-muted-foreground/50">Ikke promoveret endnu</span>
        } />
        <InfoCard label="Kladde" value={
          expert.draftVersionId
            ? <Badge variant="outline" className="text-xs text-amber-400 border-amber-500/30">{expert.draftVersionId.slice(0,8)}…</Badge>
            : <span className="text-xs text-muted-foreground/50">Ingen aktiv kladde</span>
        } />
      </div>

      {expert.description && (
        <div className="rounded-xl border border-border/30 bg-muted/5 p-4">
          <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-wide mb-1">Beskrivelse</p>
          <p className="text-sm text-foreground/80">{expert.description}</p>
        </div>
      )}

      {expert.goal && (
        <div className="rounded-xl border border-border/30 bg-muted/5 p-4">
          <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-wide mb-1">Formål</p>
          <p className="text-sm text-foreground/80">{expert.goal}</p>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-lg border border-border/20 bg-muted/5 px-3.5 py-2.5">
        <Info className="w-3.5 h-3.5 text-primary/50 shrink-0" />
        <p className="text-xs text-muted-foreground/60">AI runtime styres automatisk af BlissOps — modelvalg håndteres af platformen.</p>
      </div>

      <p className="text-xs text-muted-foreground/40">
        Sidst opdateret {new Date(expert.updatedAt).toLocaleString("da-DK")}
      </p>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/30 bg-muted/5 p-3.5">
      <p className="text-xs text-muted-foreground/50 mb-1.5">{label}</p>
      {value}
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/30 bg-muted/5 p-3.5">
      <p className="text-xs text-muted-foreground/50 mb-1.5">{label}</p>
      {value}
    </div>
  );
}

// ─── Instruktioner ────────────────────────────────────────────────────────────

const editSchema = z.object({
  name:         z.string().min(1, "Navn er påkrævet"),
  description:  z.string().optional(),
  goal:         z.string().optional(),
  instructions: z.string().optional(),
  outputStyle:  z.enum(["concise","formal","advisory"]).optional(),
  language:     z.string().optional(),
});
type EditValues = z.infer<typeof editSchema>;

function TabInstruktioner({ expert, expertId }: { expert: ExpertDetail; expertId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name:         expert.name,
      description:  expert.description ?? "",
      goal:         expert.goal ?? "",
      instructions: expert.instructions ?? "",
      outputStyle:  (expert.outputStyle as EditValues["outputStyle"]) ?? "advisory",
      language:     expert.language ?? "da",
    },
  });

  const saveMutation = useMutation({
    mutationFn: (values: EditValues) =>
      apiRequest("PATCH", `/api/experts/${expertId}`, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
      setEditing(false);
      toast({ title: "Kladde gemt", description: "Ændringer er gemt som kladde. Publicér for at gøre dem aktive." });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  if (!editing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Ekspertens AI-konfiguration og identitet.</p>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="button-edit-instructions">
            <Edit2 className="w-3.5 h-3.5 mr-1.5" />
            Rediger
          </Button>
        </div>

        <FieldDisplay label="Navn" value={expert.name} />
        <FieldDisplay label="Formål" value={expert.goal} />
        <FieldDisplay label="Beskrivelse" value={expert.description} />
        <FieldDisplay label="Instruktioner" value={expert.instructions} multiline />
        <div className="grid grid-cols-2 gap-3">
          <FieldDisplay label="Outputstil" value={
            OUTPUT_STYLE_OPTIONS.find((o) => o.value === expert.outputStyle)?.label ?? expert.outputStyle
          } />
          <FieldDisplay label="Sprog" value={
            LANGUAGE_OPTIONS.find((l) => l.value === expert.language)?.label ?? expert.language
          } />
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border/20 bg-muted/5 px-3.5 py-2.5">
          <Info className="w-3.5 h-3.5 text-primary/50 shrink-0" />
          <p className="text-xs text-muted-foreground/60">Modelvalg håndteres automatisk af BlissOps.</p>
        </div>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))} className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Ændringer gemmes som kladde — publicér for at aktivere.</p>
          <Button variant="ghost" size="sm" type="button" onClick={() => setEditing(false)}>
            Annuller
          </Button>
        </div>

        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Navn *</FormLabel>
            <FormControl><Input data-testid="input-edit-name" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="goal" render={({ field }) => (
          <FormItem>
            <FormLabel>Formål</FormLabel>
            <FormControl><Input placeholder="Hvad skal eksperten opnå?" data-testid="input-edit-goal" {...field} /></FormControl>
          </FormItem>
        )} />

        <FormField control={form.control} name="description" render={({ field }) => (
          <FormItem>
            <FormLabel>Beskrivelse</FormLabel>
            <FormControl><Textarea rows={2} data-testid="input-edit-description" {...field} /></FormControl>
          </FormItem>
        )} />

        <FormField control={form.control} name="instructions" render={({ field }) => (
          <FormItem>
            <FormLabel>Instruktioner (systemprompt)</FormLabel>
            <FormControl>
              <Textarea
                rows={5}
                placeholder="Hvad skal AI'en altid gøre, undgå eller følge?"
                data-testid="input-edit-instructions"
                {...field}
              />
            </FormControl>
            <p className="text-xs text-muted-foreground/60">Disse instruktioner er ekspertens kernekonfiguration.</p>
          </FormItem>
        )} />

        <div className="grid grid-cols-2 gap-3">
          <FormField control={form.control} name="outputStyle" render={({ field }) => (
            <FormItem>
              <FormLabel>Outputstil</FormLabel>
              <Select onValueChange={field.onChange} value={field.value ?? "advisory"}>
                <FormControl>
                  <SelectTrigger data-testid="select-edit-outputstyle"><SelectValue /></SelectTrigger>
                </FormControl>
                <SelectContent>
                  {OUTPUT_STYLE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormItem>
          )} />

          <FormField control={form.control} name="language" render={({ field }) => (
            <FormItem>
              <FormLabel>Sprog</FormLabel>
              <Select onValueChange={field.onChange} value={field.value ?? "da"}>
                <FormControl>
                  <SelectTrigger data-testid="select-edit-language"><SelectValue /></SelectTrigger>
                </FormControl>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormItem>
          )} />
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border/20 bg-muted/5 px-3.5 py-2.5">
          <Info className="w-3.5 h-3.5 text-primary/50 shrink-0" />
          <p className="text-xs text-muted-foreground/60">Modelvalg håndteres automatisk af BlissOps.</p>
        </div>

        <Button
          type="submit"
          disabled={saveMutation.isPending}
          className="w-full"
          data-testid="button-save-draft"
        >
          {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Gem kladde
        </Button>
      </form>
    </Form>
  );
}

function FieldDisplay({ label, value, multiline }: { label: string; value: string | null | undefined; multiline?: boolean }) {
  if (!value) return (
    <div className="rounded-xl border border-border/20 p-3">
      <p className="text-xs text-muted-foreground/40 mb-1">{label}</p>
      <p className="text-xs text-muted-foreground/30 italic">Ikke angivet</p>
    </div>
  );
  return (
    <div className="rounded-xl border border-border/20 p-3">
      <p className="text-xs text-muted-foreground/50 mb-1">{label}</p>
      {multiline
        ? <p className="text-sm text-foreground/80 whitespace-pre-wrap">{value}</p>
        : <p className="text-sm text-foreground/80">{value}</p>
      }
    </div>
  );
}

// ─── Regler ───────────────────────────────────────────────────────────────────

const ruleFormSchema = z.object({
  type:             z.enum(["decision","threshold","required_evidence","source_restriction","escalation"]),
  name:             z.string().min(1, "Navn er påkrævet"),
  description:      z.string().optional(),
  priority:         z.number().int().min(1).max(999).default(100),
  enforcementLevel: z.enum(["hard","soft"]).default("soft"),
});
type RuleFormValues = z.infer<typeof ruleFormSchema>;

function TabRegler({ expertId }: { expertId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd]       = useState(false);
  const [editingRule, setEditingRule] = useState<RuleRow | null>(null);

  const { data: rules, isLoading } = useQuery<RuleRow[]>({
    queryKey: ["/api/experts", expertId, "rules"],
    ...QUERY_POLICY.staticList,
  });

  const addMutation = useMutation({
    mutationFn: (values: RuleFormValues) =>
      apiRequest("POST", `/api/experts/${expertId}/rules`, { ...values, expertId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId, "rules"] });
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
      setShowAdd(false);
      toast({ title: "Regel tilføjet" });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ ruleId, values }: { ruleId: string; values: Partial<RuleFormValues> }) =>
      apiRequest("PUT", `/api/experts/${expertId}/rules/${ruleId}`, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId, "rules"] });
      setEditingRule(null);
      toast({ title: "Regel opdateret" });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (ruleId: string) =>
      apiRequest("DELETE", `/api/experts/${expertId}/rules/${ruleId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId, "rules"] });
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
      toast({ title: "Regel slettet" });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Regler styrer ekspertens beslutningsadfærd.</p>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(true)} data-testid="button-add-rule">
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Tilføj regel
        </Button>
      </div>

      {isLoading && <Skeleton className="h-16 w-full" />}

      {rules && rules.length === 0 && (
        <div className="text-center py-10 text-muted-foreground/50 text-sm">
          Ingen regler endnu. Tilføj en regel for at styre ekspertens adfærd.
        </div>
      )}

      <div className="space-y-2">
        {rules?.map((rule) => (
          <div
            key={rule.id}
            data-testid={`rule-row-${rule.id}`}
            className="rounded-xl border border-border/30 bg-card p-3.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="outline" className={`text-xs shrink-0 ${RULE_TYPE_COLORS[rule.type] ?? ""}`}>
                  {RULE_TYPE_LABELS[rule.type] ?? rule.type}
                </Badge>
                <p className="text-sm font-medium text-foreground truncate">{rule.name}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {rule.enforcementLevel === "hard"
                  ? <Badge variant="outline" className="text-xs text-rose-400 border-rose-500/30 bg-rose-500/5"><Shield className="w-2.5 h-2.5 mr-0.5" />Hard</Badge>
                  : <Badge variant="outline" className="text-xs text-blue-400 border-blue-500/30 bg-blue-500/5">Soft</Badge>
                }
                <span className="text-xs text-muted-foreground/40">P{rule.priority}</span>
                <Button variant="ghost" size="icon" className="h-6 w-6"
                  onClick={() => setEditingRule(rule)} data-testid={`edit-rule-${rule.id}`}>
                  <Edit2 className="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive/70"
                  onClick={() => deleteMutation.mutate(rule.id)} data-testid={`delete-rule-${rule.id}`}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
            {rule.description && (
              <p className="text-xs text-muted-foreground/60 mt-1.5 ml-0.5">{rule.description}</p>
            )}
          </div>
        ))}
      </div>

      <RuleDialog
        open={showAdd}
        title="Tilføj regel"
        onClose={() => setShowAdd(false)}
        onSubmit={(v) => addMutation.mutate(v)}
        isPending={addMutation.isPending}
      />

      {editingRule && (
        <RuleDialog
          open={true}
          title="Rediger regel"
          defaultValues={{
            type:             editingRule.type as RuleFormValues["type"],
            name:             editingRule.name,
            description:      editingRule.description ?? "",
            priority:         editingRule.priority,
            enforcementLevel: editingRule.enforcementLevel as "hard"|"soft",
          }}
          onClose={() => setEditingRule(null)}
          onSubmit={(v) => updateMutation.mutate({ ruleId: editingRule.id, values: v })}
          isPending={updateMutation.isPending}
        />
      )}
    </div>
  );
}

function RuleDialog({ open, title, defaultValues, onClose, onSubmit, isPending }: {
  open: boolean;
  title: string;
  defaultValues?: Partial<RuleFormValues>;
  onClose: () => void;
  onSubmit: (v: RuleFormValues) => void;
  isPending: boolean;
}) {
  const form = useForm<RuleFormValues>({
    resolver: zodResolver(ruleFormSchema),
    defaultValues: {
      type:             "decision",
      name:             "",
      description:      "",
      priority:         100,
      enforcementLevel: "soft",
      ...defaultValues,
    },
  });
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="type" render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      {Object.entries(RULE_TYPE_LABELS).map(([v,l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
              <FormField control={form.control} name="enforcementLevel" render={({ field }) => (
                <FormItem>
                  <FormLabel>Håndhævelse</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="soft">Soft (vejledende)</SelectItem>
                      <SelectItem value="hard">Hard (ufravigelig)</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem>
                <FormLabel>Navn *</FormLabel>
                <FormControl><Input placeholder="Kort, præcist regelnavn" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Beskrivelse</FormLabel>
                <FormControl><Textarea rows={2} placeholder="Hvad styrer denne regel?" {...field} /></FormControl>
              </FormItem>
            )} />
            <FormField control={form.control} name="priority" render={({ field }) => (
              <FormItem>
                <FormLabel>Prioritet (1=højest, 999=lavest)</FormLabel>
                <FormControl>
                  <Input
                    type="number" min={1} max={999}
                    {...field}
                    onChange={(e) => field.onChange(parseInt(e.target.value) || 100)}
                  />
                </FormControl>
              </FormItem>
            )} />
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1" onClick={onClose}>Annuller</Button>
              <Button type="submit" className="flex-1" disabled={isPending}>
                {isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                Gem
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Datakilder ───────────────────────────────────────────────────────────────

const sourceFormSchema = z.object({
  sourceName: z.string().min(1, "Navn er påkrævet"),
  sourceType: z.enum(["document","policy","legal","rulebook","image","other"]).default("document"),
});
type SourceFormValues = z.infer<typeof sourceFormSchema>;

interface AuthenticityResult {
  risk_score: number;
  risk_level: "low_risk" | "medium_risk" | "high_risk" | "unknown";
  signals: string[];
  has_risk: boolean;
  notes: string;
  checked_at: string;
}

function AuthenticityBadge({ result }: { result: AuthenticityResult }) {
  const config = {
    low_risk:    { label: "Lav risiko",    cls: "text-green-400 border-green-500/30 bg-green-500/10", icon: ShieldCheck },
    medium_risk: { label: "Medium risiko", cls: "text-amber-400 border-amber-500/30 bg-amber-500/10", icon: ShieldAlert },
    high_risk:   { label: "Høj risiko",    cls: "text-red-400 border-red-500/30 bg-red-500/10",       icon: ShieldAlert },
    unknown:     { label: "Ukendt",        cls: "text-muted-foreground",                               icon: Shield },
  }[result.risk_level] ?? { label: "Ukendt", cls: "text-muted-foreground", icon: Shield };
  const IconC = config.icon;
  return (
    <Badge variant="outline" className={`text-xs gap-1 ${config.cls}`} title={result.notes}>
      <IconC className="w-3 h-3" />
      {config.label}
    </Badge>
  );
}

function TabDatakilder({ expertId }: { expertId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [authenticityResults, setAuthenticityResults] = useState<Record<string, AuthenticityResult>>({});
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);

  const { data: sources, isLoading } = useQuery<SourceRow[]>({
    queryKey: ["/api/experts", expertId, "sources"],
    ...QUERY_POLICY.staticList,
  });

  const form = useForm<SourceFormValues>({
    resolver: zodResolver(sourceFormSchema),
    defaultValues: { sourceName: "", sourceType: "document" },
  });

  const addMutation = useMutation({
    mutationFn: (values: SourceFormValues) =>
      apiRequest("POST", `/api/experts/${expertId}/sources`, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId, "sources"] });
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
      form.reset();
      setShowAdd(false);
      toast({ title: "Datakilde tilknyttet" });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (sourceId: string) =>
      apiRequest("DELETE", `/api/experts/${expertId}/sources/${sourceId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId, "sources"] });
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
      toast({ title: "Datakilde fjernet" });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const analyzeAuthenticity = async (sourceId: string) => {
    setAnalyzingId(sourceId);
    try {
      const res = await apiRequest(
        "POST", `/api/experts/${expertId}/sources/${sourceId}/analyze-authenticity`
      );
      const result = await res.json() as AuthenticityResult;
      setAuthenticityResults((prev) => ({ ...prev, [sourceId]: result }));
      toast({
        title: result.has_risk ? "Risikosignaler fundet" : "Kildeanalyse gennemført",
        description: result.notes,
        variant: result.has_risk ? "destructive" : "default",
      });
    } catch (err) {
      toast({ title: "Analysefejl", description: friendlyError(err as ApiError | Error), variant: "destructive" });
    } finally {
      setAnalyzingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Datakilder giver eksperten adgang til virksomhedens viden.</p>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(true)} data-testid="button-add-source">
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Tilknyt kilde
        </Button>
      </div>

      {isLoading && <Skeleton className="h-16 w-full" />}

      {sources && sources.length === 0 && (
        <div className="text-center py-10 text-muted-foreground/50 text-sm">
          Ingen datakilder tilknyttet endnu.
        </div>
      )}

      <div className="space-y-2">
        {sources?.map((source) => {
          const lifecycle = STATUS_LIFECYCLE[source.status] ?? { label: source.status, color: "text-muted-foreground" };
          const authResult = authenticityResults[source.id];
          const isAnalyzing = analyzingId === source.id;
          return (
            <div key={source.id} data-testid={`source-row-${source.id}`}
              className="rounded-xl border border-border/30 bg-card p-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Database className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                  <p className="text-sm font-medium text-foreground truncate">{source.sourceName}</p>
                  <Badge variant="outline" className="text-xs shrink-0 text-muted-foreground/60">
                    {SOURCE_TYPE_LABELS[source.sourceType] ?? source.sourceType}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {authResult && <AuthenticityBadge result={authResult} />}
                  <Badge variant="outline" className={`text-xs ${lifecycle.color}`}>
                    {lifecycle.label}
                  </Badge>
                  <Button
                    variant="ghost" size="icon" className="h-6 w-6 text-primary/60 hover:text-primary"
                    onClick={() => analyzeAuthenticity(source.id)}
                    disabled={isAnalyzing}
                    title="Analyser kildeautenticitet"
                    data-testid={`analyze-source-${source.id}`}
                  >
                    {isAnalyzing
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <ShieldCheck className="w-3 h-3" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive/70"
                    onClick={() => deleteMutation.mutate(source.id)} data-testid={`delete-source-${source.id}`}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              {source.processingNotes && (
                <p className="text-xs text-muted-foreground/50 mt-1.5">{source.processingNotes}</p>
              )}
              {authResult && authResult.signals.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border/20">
                  <p className="text-xs text-muted-foreground/60">{authResult.notes}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Dialog open={showAdd} onOpenChange={(v) => { if (!v) setShowAdd(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Tilknyt datakilde</DialogTitle>
            <DialogDescription>Tilknyt en videnkilde til denne ekspert.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => addMutation.mutate(v))} className="space-y-4">
              <FormField control={form.control} name="sourceName" render={({ field }) => (
                <FormItem>
                  <FormLabel>Navn *</FormLabel>
                  <FormControl><Input placeholder="f.eks. Interne retningslinjer 2024" data-testid="input-source-name" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="sourceType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Kildetype</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      {Object.entries(SOURCE_TYPE_LABELS).map(([v,l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setShowAdd(false)}>Annuller</Button>
                <Button type="submit" className="flex-1" disabled={addMutation.isPending}>
                  {addMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  Tilknyt
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Test ─────────────────────────────────────────────────────────────────────

function TabTest({ expertId, expert }: { expertId: string; expert: ExpertDetail }) {
  const { toast } = useToast();
  const [prompt,     setPrompt]     = useState("");
  const [testVersion, setTestVersion] = useState<"draft"|"live">("live");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [isRunning,  setIsRunning]  = useState(false);

  const hasDraft = !!expert.draftVersionId;
  const hasLive  = !!expert.currentVersionId;

  const handleRun = async () => {
    if (!prompt.trim()) return;
    setIsRunning(true);
    setTestResult(null);
    try {
      const res = await apiRequest("POST", `/api/experts/${expertId}/test`, {
        prompt,
        version: testVersion,
      });
      const result = await res.json() as TestResult;
      setTestResult(result);
    } catch (err) {
      toast({
        title: "Test fejlet",
        description: friendlyError(err as ApiError | Error),
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Test eksperten med et reelt input — vælg kladde eller live version.
      </p>

      <div className="flex gap-2">
        <Button
          variant={testVersion === "live" ? "default" : "outline"}
          size="sm"
          onClick={() => setTestVersion("live")}
          disabled={!hasLive}
          data-testid="button-test-live"
        >
          Live {!hasLive && <span className="ml-1 text-xs opacity-50">(ingen)</span>}
        </Button>
        <Button
          variant={testVersion === "draft" ? "default" : "outline"}
          size="sm"
          onClick={() => setTestVersion("draft")}
          disabled={!hasDraft}
          data-testid="button-test-draft"
        >
          <Sparkles className="w-3.5 h-3.5 mr-1.5" />
          Kladde {!hasDraft && <span className="ml-1 text-xs opacity-50">(ingen)</span>}
        </Button>
      </div>

      {testVersion === "draft" && !hasDraft && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3.5 py-2.5 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-400">Ingen kladde endnu. Gem ændringer i Instruktioner for at oprette en kladde.</p>
        </div>
      )}

      <Textarea
        placeholder="Skriv dit testspørgsmål eller scenarie her..."
        rows={4}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        data-testid="input-test-prompt"
      />

      <Button
        onClick={handleRun}
        disabled={!prompt.trim() || isRunning || (testVersion === "draft" && !hasDraft)}
        className="w-full"
        data-testid="button-run-test"
      >
        {isRunning
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Kører test...</>
          : <><PlayCircle className="w-4 h-4 mr-2" />Kør test ({testVersion === "draft" ? "kladde" : "live"})</>
        }
      </Button>

      {testResult && (
        <div className="space-y-3" data-testid="test-result">
          <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-400" />
                <span className="text-xs font-semibold text-green-400">Ekspertsvar</span>
                {testResult.version_tested && (
                  <Badge variant="outline" className={`text-xs ${
                    testResult.version_tested === "draft"
                      ? "text-amber-400 border-amber-500/30"
                      : "text-green-400 border-green-500/30"
                  }`}>
                    {testResult.version_tested === "draft" ? "Kladde" : "Live"}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground/40" data-testid="test-observability">
                <Clock className="w-3 h-3" />
                {testResult.latency_ms}ms
                <span>·</span>
                <span>{testResult.model_name}</span>
                <span>·</span>
                <span>{testResult.provider}</span>
              </div>
            </div>
            <p className="text-sm text-foreground whitespace-pre-wrap">{testResult.output}</p>
          </div>

          {testResult.used_rules.length > 0 && (
            <div className="rounded-lg border border-border/40 bg-muted/5 p-3">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">Anvendte regler</p>
              <div className="space-y-1">
                {testResult.used_rules.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Scale className="w-3 h-3 shrink-0" />
                    <span>{r.name}</span>
                    {r.enforcement_level === "hard" && <Shield className="w-3 h-3 text-rose-400 shrink-0" />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {testResult.used_sources.length > 0 && (
            <div className="rounded-lg border border-border/40 bg-muted/5 p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Anvendte kilder</p>
                {testResult.retrieved_chunks !== undefined && testResult.retrieved_chunks > 0 && (
                  <span className="text-xs text-primary/60">
                    {testResult.retrieved_chunks} semantisk hentede
                    {testResult.retrieval_strategy && ` · ${testResult.retrieval_strategy}`}
                    {testResult.retrieval_latency_ms && ` · ${testResult.retrieval_latency_ms}ms`}
                  </span>
                )}
              </div>
              <div className="space-y-1">
                {testResult.used_sources.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Database className="w-3 h-3 shrink-0" />
                    <span className="flex-1">{s.name}</span>
                    {s.retrieval_type === "semantic" && s.relevance_score !== undefined && (
                      <span className="text-primary/50 font-mono">{(s.relevance_score * 100).toFixed(0)}%</span>
                    )}
                    {s.retrieval_type === "semantic" && (
                      <Badge variant="outline" className="text-xs py-0 text-primary/50 border-primary/20">Semantisk</Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {testResult.warnings.length > 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-400">{testResult.warnings.join(" ")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Historik ─────────────────────────────────────────────────────────────────

function TabHistorik({ expertId }: { expertId: string }) {
  const { data: versions, isLoading } = useQuery<VersionRow[]>({
    queryKey: ["/api/experts", expertId, "versions"],
    ...QUERY_POLICY.staticList,
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Alle versioner af denne ekspert.</p>

      {isLoading && <Skeleton className="h-16 w-full" />}

      {versions && versions.length === 0 && (
        <div className="text-center py-10 text-muted-foreground/50 text-sm">
          Ingen versioner endnu. Gem en kladde og publicér for at se historik.
        </div>
      )}

      <div className="space-y-2">
        {versions?.map((v) => (
          <div key={v.id} data-testid={`version-row-${v.id}`}
            className="rounded-xl border border-border/30 bg-card p-3.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-7 h-7 rounded-md bg-muted/20 shrink-0">
                <History className="w-3.5 h-3.5 text-muted-foreground/50" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Version {v.versionNumber}</p>
                <p className="text-xs text-muted-foreground/50">
                  {new Date(v.createdAt).toLocaleString("da-DK")}
                </p>
              </div>
            </div>
            <Badge variant="outline" className={`text-xs ${
              v.status === "live"     ? "text-green-400 border-green-500/30 bg-green-500/5" :
              v.status === "draft"    ? "text-amber-400 border-amber-500/30 bg-amber-500/5" :
                                        "text-muted-foreground border-border/30"
            }`}>
              {v.status === "live" ? "Live" : v.status === "draft" ? "Kladde" : "Arkiveret"}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Promote + Archive Toolbar ────────────────────────────────────────────────

function ExpertToolbar({ expert, expertId }: { expert: ExpertDetail; expertId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const promoteMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/experts/${expertId}/promote`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
      qc.invalidateQueries({ queryKey: ["/api/experts"] });
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId, "versions"] });
      toast({ title: "Publiceret!", description: "Kladden er nu live-versionen." });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/experts/${expertId}/archive`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
      qc.invalidateQueries({ queryKey: ["/api/experts"] });
      toast({ title: "Arkiveret" });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const unarchiveMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/experts/${expertId}/unarchive`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/experts", expertId] });
      qc.invalidateQueries({ queryKey: ["/api/experts"] });
      toast({ title: "Genaktiveret" });
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const hasDraft  = !!expert.draftVersionId;
  const isArchived = expert.status === "archived";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {hasDraft && (
        <Button
          size="sm"
          onClick={() => promoteMutation.mutate()}
          disabled={promoteMutation.isPending}
          data-testid="button-promote"
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          {promoteMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
          Udgiv ændringer
        </Button>
      )}
      {!isArchived ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => archiveMutation.mutate()}
          disabled={archiveMutation.isPending}
          data-testid="button-archive"
          className="text-muted-foreground border-border/40"
        >
          {archiveMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
          Arkivér ekspert
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => unarchiveMutation.mutate()}
          disabled={unarchiveMutation.isPending}
          data-testid="button-unarchive"
        >
          {unarchiveMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
          Genaktivér ekspert
        </Button>
      )}
    </div>
  );
}

// ─── Hoved-komponent ──────────────────────────────────────────────────────────

export default function AiEkspertDetail() {
  usePagePerf("ai-ekspert-detail");
  const [, navigate] = useLocation();
  const [, params]   = useRoute("/ai-eksperter/:id");
  const expertId     = params?.id ?? "";
  const [tab, setTab] = useState<Tab>("overblik");

  const { data: expert, isLoading, error } = useQuery<ExpertDetail>({
    queryKey: ["/api/experts", expertId],
    enabled:  !!expertId,
    ...QUERY_POLICY.staticList,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-6 max-w-3xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !expert) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12">
        <AlertTriangle className="w-10 h-10 text-destructive/50" />
        <p className="text-muted-foreground">Eksperten blev ikke fundet eller du har ikke adgang.</p>
        <Button variant="outline" onClick={() => navigate("/ai-eksperter")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Tilbage
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0 h-full">
      {/* ── Top bar ──────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 border-b border-border/30 bg-background/95 backdrop-blur-sm px-5 py-3">
        <div className="flex items-center justify-between gap-3 max-w-3xl mx-auto">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => navigate("/ai-eksperter")}
              data-testid="button-back"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex items-center justify-center w-7 h-7 rounded-md bg-primary/10 shrink-0">
                <Brain className="w-3.5 h-3.5 text-primary" />
              </div>
              <p className="text-sm font-semibold text-foreground truncate">{expert.name}</p>
              <Badge variant="outline" className={`text-xs shrink-0 ${
                expert.status === "active" ? "text-green-400 border-green-500/30" : "text-muted-foreground"
              }`}>
                {expert.status === "active" ? "Aktiv" : "Arkiveret"}
              </Badge>
              {expert.draftVersionId && (
                <Badge variant="outline" className="text-xs shrink-0 text-amber-400 border-amber-500/30">
                  Kladde
                </Badge>
              )}
            </div>
          </div>
          <ExpertToolbar expert={expert} expertId={expertId} />
        </div>
      </div>

      {/* ── Tab navigation ───────────────────────────────────────────────────── */}
      <div className="border-b border-border/30 bg-background px-5">
        <div className="flex gap-0 max-w-3xl mx-auto overflow-x-auto scrollbar-hide">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              data-testid={`tab-${id}`}
              className={`flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
                tab === id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground/60 hover:text-muted-foreground"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab content ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="max-w-3xl mx-auto">
          {tab === "overblik"      && <TabOverblik expert={expert} />}
          {tab === "instruktioner" && <TabInstruktioner expert={expert} expertId={expertId} />}
          {tab === "regler"        && <TabRegler expertId={expertId} />}
          {tab === "datakilder"    && <TabDatakilder expertId={expertId} />}
          {tab === "test"          && <TabTest expertId={expertId} expert={expert} />}
          {tab === "historik"      && <TabHistorik expertId={expertId} />}
        </div>
      </div>
    </div>
  );
}
