/**
 * AI Eksperter — Primær produktside
 *
 * 5-trins wizard med staged oprettelse:
 * Step 1-4: Indsaml data → Step 4→5 overgang: opret ekspert + rules + sources
 * Step 5: Test den oprettede ekspert via /api/experts/:id/test
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Plus, Brain, MoreHorizontal, Sparkles, ChevronRight, ChevronLeft,
  FileText, Scale, PlayCircle, CheckCircle2, Database, Loader2,
  BookOpen, Wand2, X, AlertTriangle, Shield, Clock, ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

interface ExpertRow {
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
  createdAt: string;
  updatedAt: string;
}

interface DeptRow { id: string; name: string; }

interface PendingSource {
  sourceName: string;
  sourceType: "document" | "policy" | "legal" | "rulebook" | "image" | "other";
}

interface PendingRule {
  type: "decision" | "threshold" | "required_evidence" | "source_restriction" | "escalation";
  name: string;
  description: string;
  priority: number;
  enforcementLevel: "hard" | "soft";
}

interface AiSuggestion {
  suggested_name:         string;
  improved_description:   string;
  goal:                   string;
  instructions:           string;
  suggested_output_style: "concise" | "formal" | "advisory";
  suggested_rules: Array<{
    type:             string;
    name:             string;
    description:      string;
    priority:         number;
    enforcement_level: "hard" | "soft";
  }>;
  suggested_source_types: string[];
  warnings:               string[];
}

interface TestResult {
  output:          string;
  used_rules:      Array<{ id: string; name: string; type: string; enforcement_level: string }>;
  used_sources:    Array<{ id: string; name: string; source_type: string; status: string }>;
  warnings:        string[];
  latency_ms:      number;
  version_tested?: string;
  provider:        string;
  model_name:      string;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const step1Schema = z.object({
  name:         z.string().min(1, "Navn er påkrævet"),
  slug:         z.string().min(1, "Slug er påkrævet").regex(/^[a-z0-9-]+$/, "Kun små bogstaver, tal og bindestreger"),
  description:  z.string().optional(),
  goal:         z.string().optional(),
  instructions: z.string().optional(),
  outputStyle:  z.string().optional(),
  departmentId: z.string().optional(),
  language:     z.string().default("da"),
});
type Step1Values = z.infer<typeof step1Schema>;

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

const LANGUAGE_OPTIONS = [
  { value: "da", label: "Dansk" },
  { value: "en", label: "Engelsk" },
  { value: "de", label: "Tysk" },
  { value: "sv", label: "Svensk" },
  { value: "no", label: "Norsk" },
];

const OUTPUT_STYLE_OPTIONS = [
  { value: "advisory", label: "Rådgivende" },
  { value: "formal",   label: "Formel" },
  { value: "concise",  label: "Præcis/kort" },
];

const EXPERT_EXAMPLES = [
  "Forsikringsspecialist", "Supportekspert", "Compliance Ekspert",
  "Salgsassistent", "Dokumentanalytiker",
];

const RULE_TYPE_COLORS: Record<string, string> = {
  decision:           "text-amber-400 border-amber-500/30 bg-amber-500/5",
  threshold:          "text-blue-400 border-blue-500/30 bg-blue-500/5",
  required_evidence:  "text-green-400 border-green-500/30 bg-green-500/5",
  source_restriction: "text-rose-400 border-rose-500/30 bg-rose-500/5",
  escalation:         "text-purple-400 border-purple-500/30 bg-purple-500/5",
};

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  const steps = [
    { icon: Brain,      label: "Grundinfo"    },
    { icon: Wand2,      label: "AI Forbedring" },
    { icon: Database,   label: "Data"         },
    { icon: Scale,      label: "Regler"       },
    { icon: PlayCircle, label: "Test"         },
  ];
  return (
    <div className="flex items-center gap-0 mb-5 w-full">
      {steps.map((s, i) => {
        const n = i + 1;
        const done   = n < current;
        const active = n === current;
        const Icon   = s.icon;
        return (
          <div key={n} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                done   ? "bg-primary text-primary-foreground" :
                active ? "bg-primary/20 border-2 border-primary text-primary" :
                         "bg-muted/30 border border-border text-muted-foreground"
              }`}>
                {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Icon className="w-3 h-3" />}
              </div>
              <span className={`text-[10px] whitespace-nowrap font-medium ${active ? "text-primary" : "text-muted-foreground/50"}`}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`h-px flex-1 mx-1 mb-4 transition-all ${done ? "bg-primary/50" : "bg-border/40"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Expert Card ──────────────────────────────────────────────────────────────

function ExpertCard({ expert, depts, onArchive }: {
  expert: ExpertRow; depts: DeptRow[]; onArchive: (id: string) => void;
}) {
  const [, navigate] = useLocation();
  const dept = depts.find((d) => d.id === expert.departmentId);
  return (
    <Card
      data-testid={`expert-card-${expert.id}`}
      className="bg-card border-card-border hover:border-primary/30 transition-all duration-200 hover:-translate-y-0.5 relative overflow-hidden cursor-pointer"
      onClick={() => navigate(`/ai-eksperter/${expert.id}`)}
    >
      <span className="absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full bg-primary/40" />
      <CardContent className="pt-4 pb-4 pl-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 shrink-0">
              <Brain className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-card-foreground truncate">{expert.name}</p>
              {expert.goal && (
                <p className="text-xs text-muted-foreground/70 truncate">{expert.goal}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            <Badge variant="outline" className={`text-xs border ${
              expert.status === "active"
                ? "text-green-400 border-green-500/30 bg-green-500/10"
                : "text-muted-foreground"
            }`}>
              {expert.status === "active" ? "Aktiv" : expert.status}
            </Badge>
            {expert.draftVersionId && (
              <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400 bg-amber-500/5">
                Kladde
              </Badge>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" data-testid={`expert-menu-${expert.id}`}>
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => navigate(`/ai-eksperter/${expert.id}`)}
                  data-testid={`edit-expert-${expert.id}`}
                >
                  Åbn ekspert
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onArchive(expert.id)}
                  data-testid={`archive-expert-${expert.id}`}
                >
                  Arkivér
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {expert.description && (
          <p className="text-xs text-muted-foreground mt-2.5 line-clamp-2">{expert.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          {dept && (
            <Badge variant="outline" className="text-xs border-border/40 text-muted-foreground/60">
              {dept.name}
            </Badge>
          )}
          <Badge variant="outline" className="text-xs border-muted/20 text-muted-foreground/40">
            AI runtime styres af platformen
          </Badge>
        </div>

        <div className="flex items-center justify-between mt-2.5">
          <p className="text-xs text-muted-foreground/40">
            Opdateret {new Date(expert.updatedAt).toLocaleDateString("da-DK")}
          </p>
          <span className="text-xs text-primary/50 flex items-center gap-1">
            Åbn <ArrowRight className="w-3 h-3" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Step 1: Grundoplysninger ──────────────────────────────────────────────────

function Step1({ form, depts }: { form: ReturnType<typeof useForm<Step1Values>>; depts: DeptRow[] }) {
  const watchedName = form.watch("name");
  useEffect(() => {
    if (!watchedName) return;
    const slug = watchedName.toLowerCase()
      .replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    form.setValue("slug", slug, { shouldValidate: false });
  }, [watchedName]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Angiv ekspertens grundlæggende identitet og AI-konfiguration.
      </p>
      <FormField control={form.control} name="name" render={({ field }) => (
        <FormItem>
          <FormLabel>Navn *</FormLabel>
          <FormControl><Input placeholder="f.eks. Forsikringsspecialist" data-testid="input-expert-name" {...field} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={form.control} name="goal" render={({ field }) => (
        <FormItem>
          <FormLabel>Formål</FormLabel>
          <FormControl><Input placeholder="Hvad skal eksperten opnå? (1 sætning)" data-testid="input-expert-goal" {...field} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={form.control} name="description" render={({ field }) => (
        <FormItem>
          <FormLabel>Beskrivelse</FormLabel>
          <FormControl><Textarea placeholder="Uddybende beskrivelse af ekspertens rolle og anvendelse" rows={2} data-testid="input-expert-description" {...field} /></FormControl>
        </FormItem>
      )} />
      <FormField control={form.control} name="instructions" render={({ field }) => (
        <FormItem>
          <FormLabel>Instruktioner (systemprompt)</FormLabel>
          <FormControl>
            <Textarea
              placeholder="Hvad skal AI'en altid gøre, undgå eller følge? Dette er ekspertens kerneinstruktion."
              rows={4}
              data-testid="input-expert-instructions"
              {...field}
            />
          </FormControl>
          <p className="text-xs text-muted-foreground/60">Disse instruktioner gælder for alle ekspertens svar.</p>
        </FormItem>
      )} />
      <div className="grid grid-cols-2 gap-3">
        <FormField control={form.control} name="departmentId" render={({ field }) => (
          <FormItem>
            <FormLabel>Afdeling</FormLabel>
            <Select onValueChange={field.onChange} value={field.value ?? ""}>
              <FormControl>
                <SelectTrigger data-testid="select-expert-department"><SelectValue placeholder="Vælg" /></SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="none">Ingen</SelectItem>
                {depts.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormItem>
        )} />
        <FormField control={form.control} name="language" render={({ field }) => (
          <FormItem>
            <FormLabel>Sprog</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger data-testid="select-expert-language"><SelectValue /></SelectTrigger>
              </FormControl>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormItem>
        )} />
      </div>
      <FormField control={form.control} name="outputStyle" render={({ field }) => (
        <FormItem>
          <FormLabel>Outputstil</FormLabel>
          <Select onValueChange={field.onChange} value={field.value ?? ""}>
            <FormControl>
              <SelectTrigger data-testid="select-expert-outputstyle"><SelectValue placeholder="Vælg" /></SelectTrigger>
            </FormControl>
            <SelectContent>
              {OUTPUT_STYLE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormItem>
      )} />
      <div className="rounded-lg border border-border/30 bg-muted/10 px-3.5 py-2.5 flex items-center gap-2">
        <Brain className="w-3.5 h-3.5 text-primary/50 shrink-0" />
        <p className="text-xs text-muted-foreground/60">AI runtime styres automatisk af BlissOps — ingen modelvalg nødvendigt.</p>
      </div>
      <FormField control={form.control} name="slug" render={({ field }) => (
        <FormItem>
          <FormLabel>Slug (auto-genereret)</FormLabel>
          <FormControl><Input className="font-mono text-sm" data-testid="input-expert-slug" {...field} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
    </div>
  );
}

// ─── Step 2: Forbedr med AI ───────────────────────────────────────────────────

function Step2({ suggestion, onSuggest, onAccept, isLoading, form }: {
  suggestion:  AiSuggestion | null;
  onSuggest:   (raw: string, dept?: string, lang?: string) => void;
  onAccept:    (s: AiSuggestion) => void;
  isLoading:   boolean;
  form:        ReturnType<typeof useForm<Step1Values>>;
}) {
  const [raw, setRaw] = useState("");
  const dept = form.watch("departmentId");
  const lang = form.watch("language");

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Beskriv frit hvad eksperten skal gøre — AI'en analyserer og genererer et komplet konfigurationsforslag. Valgfrit.
      </p>
      <div className="space-y-2">
        <Textarea
          placeholder="f.eks. Jeg vil have en ekspert der hjælper salgsteamet med kreditvurdering ud fra vores interne retningslinjer og historiske kundedata..."
          rows={4}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          data-testid="input-ai-raw-description"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => onSuggest(raw, dept || undefined, lang)}
          disabled={!raw.trim() || isLoading}
          className="w-full border-primary/30 text-primary hover:bg-primary/5"
          data-testid="button-ai-suggest"
        >
          {isLoading
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyserer...</>
            : <><Sparkles className="w-4 h-4 mr-2" />Forbedr med AI</>}
        </Button>
      </div>

      {suggestion && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3" data-testid="ai-suggestion-result">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-primary">AI konfigurationsforslag</span>
          </div>

          <div className="space-y-3">
            <Row label="Navn"         value={suggestion.suggested_name} />
            <Row label="Formål"       value={suggestion.goal} />
            <Row label="Beskrivelse"  value={suggestion.improved_description} />
            {suggestion.instructions && (
              <div>
                <p className="text-xs text-muted-foreground mb-0.5 uppercase tracking-wide font-bold">Instruktioner</p>
                <p className="text-xs text-foreground/80 italic border-l-2 border-primary/30 pl-2">{suggestion.instructions}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-bold">Regelkategorier</p>
                <div className="flex flex-wrap gap-1">
                  {(suggestion.suggested_rules ?? []).map((r, i) => (
                    <Badge key={i} variant="outline" className={`text-xs ${RULE_TYPE_COLORS[r.type] ?? "text-muted-foreground"}`}>
                      {RULE_TYPE_LABELS[r.type] ?? r.type}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-bold">Datatyper</p>
                <div className="flex flex-wrap gap-1">
                  {(suggestion.suggested_source_types ?? []).map((t, i) => (
                    <Badge key={i} variant="outline" className="text-xs border-blue-500/30 text-blue-400 bg-blue-500/5">
                      {SOURCE_TYPE_LABELS[t] ?? t}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            {(suggestion.warnings ?? []).length > 0 && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-400">{suggestion.warnings.join(" ")}</p>
              </div>
            )}
          </div>

          <Button type="button" size="sm" onClick={() => onAccept(suggestion)} className="w-full mt-1" data-testid="button-accept-suggestion">
            <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
            Anvend forslag
          </Button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5 uppercase tracking-wide font-bold">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}

// ─── Step 3: Viden & Data ─────────────────────────────────────────────────────

function Step3({ sources, onAdd, onRemove }: {
  sources: PendingSource[]; onAdd: (s: PendingSource) => void; onRemove: (i: number) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<PendingSource["sourceType"]>("document");

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd({ sourceName: name.trim(), sourceType: type });
    setName(""); setType("document");
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tilknyt de datakilder eksperten skal arbejde ud fra. Dokumenter, politikker, lovgivning og interne regler.
      </p>
      <div className="flex gap-2">
        <Input
          placeholder="Kildnavn, f.eks. Forsikringsbetingelser 2024"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAdd())}
          data-testid="input-source-name"
          className="flex-1"
        />
        <Select value={type} onValueChange={(v) => setType(v as PendingSource["sourceType"])}>
          <SelectTrigger className="w-36" data-testid="select-source-type"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(SOURCE_TYPE_LABELS).map(([v, l]) => (
              <SelectItem key={v} value={v}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="icon" onClick={handleAdd} disabled={!name.trim()} data-testid="button-add-source">
          <Plus className="w-4 h-4" />
        </Button>
      </div>
      {sources.length === 0 ? (
        <div className="text-center py-8 rounded-xl border border-dashed border-border/40">
          <BookOpen className="w-6 h-6 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground/50">Ingen datakilder tilføjet endnu</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sources.map((s, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/10 px-3 py-2" data-testid={`source-item-${i}`}>
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="text-sm truncate">{s.sourceName}</span>
                <Badge variant="outline" className="text-xs border-blue-500/30 text-blue-400 shrink-0">{SOURCE_TYPE_LABELS[s.sourceType]}</Badge>
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => onRemove(i)} data-testid={`remove-source-${i}`}>
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Step 4: Regler ───────────────────────────────────────────────────────────

function Step4({ rules, onAdd, onRemove }: {
  rules: PendingRule[]; onAdd: (r: PendingRule) => void; onRemove: (i: number) => void;
}) {
  const [type,  setType]  = useState<PendingRule["type"]>("decision");
  const [name,  setName]  = useState("");
  const [desc,  setDesc]  = useState("");
  const [prio,  setPrio]  = useState(100);
  const [level, setLevel] = useState<"hard" | "soft">("soft");

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd({ type, name: name.trim(), description: desc.trim(), priority: prio, enforcementLevel: level });
    setName(""); setDesc(""); setPrio(100); setLevel("soft");
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Definer hvilke regler eksperten skal følge. Ufravigelige regler overskrives aldrig.
      </p>
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Select value={type} onValueChange={(v) => setType(v as PendingRule["type"])}>
            <SelectTrigger data-testid="select-rule-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(RULE_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={level} onValueChange={(v) => setLevel(v as "hard" | "soft")}>
            <SelectTrigger data-testid="select-rule-enforcement">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hard">
                <div className="flex items-center gap-1.5">
                  <Shield className="w-3 h-3 text-rose-400" />
                  Ufravigelig
                </div>
              </SelectItem>
              <SelectItem value="soft">
                <div className="flex items-center gap-1.5">
                  <Scale className="w-3 h-3 text-blue-400" />
                  Vejledende
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Input
          placeholder="Regelnavn, f.eks. Max kreditgrænse 500.000 kr."
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="input-rule-name"
        />
        <Textarea
          placeholder="Uddybende beskrivelse (valgfri)"
          rows={2}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          data-testid="input-rule-description"
        />
        <Button type="button" variant="outline" onClick={handleAdd} disabled={!name.trim()} className="w-full" data-testid="button-add-rule">
          <Plus className="w-4 h-4 mr-1.5" />Tilføj regel
        </Button>
      </div>
      {rules.length === 0 ? (
        <div className="text-center py-6 rounded-xl border border-dashed border-border/40">
          <Scale className="w-6 h-6 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground/50">Ingen regler tilføjet endnu</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.sort((a, b) => a.priority - b.priority).map((r, i) => (
            <div key={i} className="flex items-start justify-between rounded-lg border border-border/40 bg-muted/10 px-3 py-2.5" data-testid={`rule-item-${i}`}>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-xs ${RULE_TYPE_COLORS[r.type]}`}>
                    {RULE_TYPE_LABELS[r.type]}
                  </Badge>
                  {r.enforcementLevel === "hard" && (
                    <Badge variant="outline" className="text-xs text-rose-400 border-rose-500/30 bg-rose-500/5">
                      <Shield className="w-2.5 h-2.5 mr-1" />Ufravigelig
                    </Badge>
                  )}
                  <span className="text-sm font-medium truncate">{r.name}</span>
                </div>
                {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 ml-2" onClick={() => onRemove(i)} data-testid={`remove-rule-${i}`}>
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Step 5: Test Ekspert (kræver expertId) ───────────────────────────────────

function Step5({ expertId, expertName, sources, rules }: {
  expertId:   string;
  expertName: string;
  sources:    PendingSource[];
  rules:      PendingRule[];
}) {
  const { toast }                     = useToast();
  const [query, setQuery]             = useState("");
  const [testResult, setTestResult]   = useState<TestResult | null>(null);

  const testMutation = useMutation({
    mutationFn: (prompt: string) =>
      apiRequest<TestResult>("POST", `/api/experts/${expertId}/test`, { prompt }),
    onSuccess: (data) => setTestResult(data),
    onError:   (err: ApiError | Error) =>
      toast({ title: "Test fejl", description: friendlyError(err), variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <span className="text-sm font-semibold text-green-400">Ekspert oprettet</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Brain className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">{expertName}</p>
            <div className="flex gap-3 text-xs text-muted-foreground">
              <span>{sources.length} datakilde{sources.length !== 1 ? "r" : ""}</span>
              <span>{rules.length} regel{rules.length !== 1 ? "r" : ""}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Prøv eksperten af med et eksempel, før den sættes i brug.
        </p>
        <Textarea
          placeholder="f.eks. Kan vi godkende en kredit på 300.000 kr. til en kunde med kreditvurdering B+?"
          rows={3}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="input-test-query"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => testMutation.mutate(query)}
          disabled={!query.trim() || testMutation.isPending}
          className="w-full"
          data-testid="button-run-test"
        >
          {testMutation.isPending
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Kører test...</>
            : <><PlayCircle className="w-4 h-4 mr-2" />Kør test</>}
        </Button>
      </div>

      {testResult && (
        <div className="space-y-3" data-testid="test-result">
          <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-400" />
                <span className="text-xs font-semibold text-green-400">Ekspertsvar</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                <Clock className="w-3 h-3" />
                {testResult.latency_ms}ms · {testResult.model_name} · {testResult.provider}
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

// ─── Create Wizard ────────────────────────────────────────────────────────────

function CreateWizard({ open, onClose, depts, onCreated }: {
  open: boolean; onClose: () => void; depts: DeptRow[]; onCreated: () => void;
}) {
  const { toast }        = useToast();
  const [step, setStep]  = useState(1);
  const TOTAL            = 5;

  const form = useForm<Step1Values>({
    resolver: zodResolver(step1Schema),
    defaultValues: {
      name: "", slug: "", description: "", goal: "", instructions: "",
      outputStyle: "advisory", departmentId: "", language: "da",
    },
  });

  const [suggestion,    setSuggestion]   = useState<AiSuggestion | null>(null);
  const [sources,       setSources]      = useState<PendingSource[]>([]);
  const [rules,         setRules]        = useState<PendingRule[]>([]);
  const [createdId,     setCreatedId]    = useState<string | null>(null);
  const [isTransitioning, setTransitioning] = useState(false);

  // ── AI Suggest ──────────────────────────────────────────────────────────────
  const aiSuggestMutation = useMutation({
    mutationFn: (p: { rawDescription: string; department?: string; language?: string }) =>
      apiRequest<AiSuggestion>("POST", "/api/experts/ai-suggest", p),
    onSuccess: (data) => setSuggestion(data),
    onError:   (err: ApiError | Error) =>
      toast({ title: "AI fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const handleAcceptSuggestion = (s: AiSuggestion) => {
    form.setValue("name",         s.suggested_name);
    form.setValue("goal",         s.goal);
    form.setValue("description",  s.improved_description);
    form.setValue("instructions", s.instructions);
    if (s.suggested_output_style) form.setValue("outputStyle", s.suggested_output_style);
    const slug = s.suggested_name.toLowerCase()
      .replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    form.setValue("slug", slug);
    // Pre-fill rules from suggestion
    const newRules = (s.suggested_rules ?? []).map((r) => ({
      type:            r.type as PendingRule["type"],
      name:            r.name,
      description:     r.description,
      priority:        r.priority,
      enforcementLevel: r.enforcement_level,
    }));
    if (newRules.length > 0) setRules(newRules);
    toast({ title: "Forslag anvendt", description: "Grundoplysninger og regler er forudfyldt." });
  };

  // ── Staged creation (step 4 → step 5) ─────────────────────────────────────
  const handleCreateAndAdvance = async (values: Step1Values) => {
    setTransitioning(true);
    try {
      // 1. Create expert (model/provider managed server-side)
      const profile = await apiRequest<ExpertRow>("POST", "/api/experts", {
        name:         values.name,
        slug:         values.slug,
        description:  values.description || undefined,
        goal:         values.goal || undefined,
        instructions: values.instructions || undefined,
        outputStyle:  values.outputStyle === "advisory" ? undefined : values.outputStyle,
        departmentId: values.departmentId === "none" ? undefined : values.departmentId || undefined,
        language:     values.language,
        category:     undefined,
      });

      // 2. Attach rules (sequential, safe)
      for (const r of rules) {
        await apiRequest("POST", `/api/experts/${profile.id}/rules`, r);
      }

      // 3. Attach sources (sequential, safe)
      for (const s of sources) {
        await apiRequest("POST", `/api/experts/${profile.id}/sources`, s);
      }

      setCreatedId(profile.id);
      invalidate(["/api/experts"]);
      setStep(5);
    } catch (err) {
      toast({ title: "Fejl ved oprettelse", description: friendlyError(err as ApiError | Error), variant: "destructive" });
    } finally {
      setTransitioning(false);
    }
  };

  const handleClose = () => {
    onClose();
    setTimeout(() => {
      setStep(1); setSuggestion(null); setSources([]); setRules([]);
      setCreatedId(null);
      form.reset();
    }, 300);
  };

  const handleNext = async () => {
    if (step === 1) {
      const valid = await form.trigger(["name", "slug"]);
      if (!valid) return;
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    } else if (step === 3) {
      setStep(4);
    } else if (step === 4) {
      // Staged creation before entering step 5
      form.handleSubmit(handleCreateAndAdvance)();
    }
  };

  const handleBack = () => setStep((s) => Math.max(s - 1, 1));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col overflow-hidden" data-testid="dialog-create-expert">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Opret AI ekspert
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="px-1 pb-2">
            <StepIndicator current={step} total={TOTAL} />
            <Form {...form}>
              <form onSubmit={(e) => e.preventDefault()}>
                {step === 1 && <Step1 form={form} depts={depts} />}
                {step === 2 && (
                  <Step2
                    suggestion={suggestion}
                    onSuggest={(raw, dept, lang) => aiSuggestMutation.mutate({
                      rawDescription: raw,
                      department: dept,
                      language: lang,
                    })}
                    onAccept={handleAcceptSuggestion}
                    isLoading={aiSuggestMutation.isPending}
                    form={form}
                  />
                )}
                {step === 3 && (
                  <Step3
                    sources={sources}
                    onAdd={(s) => setSources((p) => [...p, s])}
                    onRemove={(i) => setSources((p) => p.filter((_, j) => j !== i))}
                  />
                )}
                {step === 4 && (
                  <Step4
                    rules={rules}
                    onAdd={(r) => setRules((p) => [...p, r])}
                    onRemove={(i) => setRules((p) => p.filter((_, j) => j !== i))}
                  />
                )}
                {step === 5 && createdId && (
                  <Step5
                    expertId={createdId}
                    expertName={form.watch("name")}
                    sources={sources}
                    rules={rules}
                  />
                )}
              </form>
            </Form>
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-border/40 shrink-0">
          <Button
            type="button"
            variant="ghost"
            onClick={step === 1 ? handleClose : step === 5 ? handleClose : handleBack}
            disabled={isTransitioning}
            data-testid="button-wizard-back"
          >
            {step === 1 ? "Annuller" : step === 5 ? "Luk" : <><ChevronLeft className="w-4 h-4 mr-1" />Tilbage</>}
          </Button>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{step} / {TOTAL}</span>
            {step < 5 && (
              <Button
                type="button"
                onClick={handleNext}
                disabled={isTransitioning}
                data-testid="button-wizard-next"
              >
                {isTransitioning ? (
                  <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />Opretter...</>
                ) : step === 4 ? (
                  <><CheckCircle2 className="w-4 h-4 mr-1.5" />Opret ekspert</>
                ) : (
                  <>Næste <ChevronRight className="w-4 h-4 ml-1" /></>
                )}
              </Button>
            )}
            {step === 5 && (
              <Button type="button" onClick={() => { onCreated(); handleClose(); }} data-testid="button-finish">
                <CheckCircle2 className="w-4 h-4 mr-1.5" />Færdig
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AiEksperter() {
  usePagePerf("ai-eksperter");
  const { toast }                   = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data: experts, isLoading } = useQuery<ExpertRow[]>({
    queryKey: ["/api/experts"],
    ...QUERY_POLICY.list,
  });

  const { data: depts = [] } = useQuery<DeptRow[]>({
    queryKey: ["/api/tenant/departments"],
    ...QUERY_POLICY.list,
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/experts/${id}/archive`, {}),
    onSuccess:  () => { toast({ title: "Ekspert arkiveret" }); invalidate(["/api/experts"]); },
    onError:    (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const active   = experts?.filter((e) => e.status === "active") ?? [];
  const archived = experts?.filter((e) => e.status !== "active") ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl" data-testid="page-ai-eksperter">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.18)" }}
            >
              <Brain className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-page-title">
              AI Eksperter
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Opret og administrér AI eksperter, der arbejder ud fra jeres egne data, regler og processer.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} data-testid="button-create-expert" className="shrink-0">
          <Plus className="w-4 h-4 mr-1.5" />Opret ekspert
        </Button>
      </div>

      {/* Expert list */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
        </div>
      ) : active.length === 0 ? (
        <div className="text-center py-20 space-y-4">
          <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)" }}>
            <Brain className="w-7 h-7 text-primary/60" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground mb-1">Ingen AI eksperter endnu</p>
            <p className="text-sm text-muted-foreground">
              Opret din første ekspert — f.eks. en{" "}
              <span className="text-primary/80">
                {EXPERT_EXAMPLES[Math.floor(Math.random() * EXPERT_EXAMPLES.length)]}
              </span>
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)} data-testid="button-empty-create-expert">
            <Plus className="w-4 h-4 mr-1.5" />Opret AI ekspert
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {active.map((e) => (
              <ExpertCard key={e.id} expert={e} depts={depts} onArchive={(id) => archiveMutation.mutate(id)} />
            ))}
          </div>
          {archived.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground/50 uppercase tracking-widest font-bold mb-3">Arkiverede</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 opacity-50">
                {archived.map((e) => <ExpertCard key={e.id} expert={e} depts={depts} onArchive={() => {}} />)}
              </div>
            </div>
          )}
        </div>
      )}

      <CreateWizard
        open={showCreate}
        onClose={() => setShowCreate(false)}
        depts={depts}
        onCreated={() => invalidate(["/api/experts"])}
      />
    </div>
  );
}
