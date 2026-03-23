/**
 * AI Eksperter — Primær produktside
 *
 * Opret og administrér AI eksperter.
 * Bruger architecture_profiles, specialist_rules og specialist_sources.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Plus, Brain, MoreHorizontal, Tag, Sparkles, ChevronRight, ChevronLeft,
  FileText, Scale, PlayCircle, CheckCircle2, Database, Loader2, Trash2,
  BookOpen, AlertCircle, Wand2, X,
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
  category: string | null;
  departmentId: string | null;
  language: string | null;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeptRow { id: string; name: string; }

interface PendingSource {
  sourceName: string;
  sourceType: "document" | "policy" | "legal" | "rule" | "image";
}

interface PendingRule {
  type: "decision" | "threshold" | "required_evidence" | "source_restriction";
  name: string;
  description: string;
}

interface AiSuggestion {
  improvedTitle: string;
  improvedDescription: string;
  responsibilities: string[];
  suggestedRuleThemes: string[];
  suggestedDataTypes: string[];
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const step1Schema = z.object({
  name:         z.string().min(1, "Navn er påkrævet"),
  slug:         z.string().min(1, "Slug er påkrævet").regex(/^[a-z0-9-]+$/, "Kun små bogstaver, tal og bindestreger"),
  description:  z.string().optional(),
  departmentId: z.string().optional(),
  language:     z.string().default("da"),
});
type Step1Values = z.infer<typeof step1Schema>;

// ─── Constants ────────────────────────────────────────────────────────────────

const RULE_TYPE_LABELS: Record<string, string> = {
  decision:            "Beslutningsregel",
  threshold:           "Tærskelregel",
  required_evidence:   "Dokumentationskrav",
  source_restriction:  "Kildebegrænsning",
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  document: "Dokument",
  policy:   "Politikdokument",
  legal:    "Juridisk dokument",
  rule:     "Regelsæt",
  image:    "Billede",
};

const LANGUAGE_OPTIONS = [
  { value: "da", label: "Dansk" },
  { value: "en", label: "Engelsk" },
  { value: "de", label: "Tysk" },
  { value: "sv", label: "Svensk" },
  { value: "no", label: "Norsk" },
];

const EXPERT_EXAMPLES = [
  "Forsikringsspecialist",
  "Supportekspert",
  "Compliance Ekspert",
  "Salgsassistent",
  "Dokumentanalytiker",
];

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  const steps = [
    { icon: Brain,      label: "Grundinfo"   },
    { icon: Wand2,      label: "AI Forbedring" },
    { icon: Database,   label: "Viden & Data" },
    { icon: Scale,      label: "Regler"       },
    { icon: PlayCircle, label: "Test"         },
  ];
  return (
    <div className="flex items-center gap-0 mb-6 w-full">
      {steps.map((s, i) => {
        const n = i + 1;
        const done   = n < current;
        const active = n === current;
        const Icon   = s.icon;
        return (
          <div key={n} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                  done   ? "bg-primary text-primary-foreground" :
                  active ? "bg-primary/20 border-2 border-primary text-primary" :
                           "bg-muted/30 border border-border text-muted-foreground"
                }`}
              >
                {done ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : (
                  <Icon className="w-3 h-3" />
                )}
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

function ExpertCard({
  expert,
  depts,
  onArchive,
}: {
  expert: ExpertRow;
  depts: DeptRow[];
  onArchive: (id: string) => void;
}) {
  const dept = depts.find((d) => d.id === expert.departmentId);
  return (
    <Card
      data-testid={`expert-card-${expert.id}`}
      className="bg-card border-card-border hover:border-primary/30 transition-all duration-200 hover:-translate-y-0.5 relative overflow-hidden"
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
              <p className="text-xs text-muted-foreground font-mono truncate">{expert.slug}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge
              variant="outline"
              className={`text-xs border capitalize ${
                expert.status === "active"
                  ? "text-green-400 border-green-500/30 bg-green-500/10"
                  : "text-muted-foreground"
              }`}
            >
              {expert.status === "active" ? "Aktiv" : expert.status}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" data-testid={`expert-menu-${expert.id}`}>
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
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
          <p className="text-xs text-muted-foreground mt-3 line-clamp-2">{expert.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {dept && (
            <div className="flex items-center gap-1">
              <Tag className="w-3 h-3 text-muted-foreground/60" />
              <span className="text-xs text-muted-foreground/60">{dept.name}</span>
            </div>
          )}
          {expert.language && expert.language !== "da" && (
            <Badge variant="outline" className="text-xs border-border/40 text-muted-foreground/50">
              {LANGUAGE_OPTIONS.find((l) => l.value === expert.language)?.label ?? expert.language}
            </Badge>
          )}
        </div>

        <p className="text-xs text-muted-foreground/40 mt-3">
          Opdateret {new Date(expert.updatedAt).toLocaleDateString("da-DK")}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Step 1: Grundoplysninger ──────────────────────────────────────────────────

function Step1({
  form,
  depts,
}: {
  form: ReturnType<typeof useForm<Step1Values>>;
  depts: DeptRow[];
}) {
  const watchedName = form.watch("name");
  useEffect(() => {
    if (!watchedName) return;
    const slug = watchedName
      .toLowerCase()
      .replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    form.setValue("slug", slug, { shouldValidate: false });
  }, [watchedName]);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground mb-4">
          Beskriv hvad AI eksperten skal kunne, hvilke data den skal bruge, og hvilke regler den skal følge.
        </p>
      </div>
      <FormField control={form.control} name="name" render={({ field }) => (
        <FormItem>
          <FormLabel>Navn</FormLabel>
          <FormControl>
            <Input placeholder="f.eks. Forsikringsspecialist" data-testid="input-expert-name" {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={form.control} name="slug" render={({ field }) => (
        <FormItem>
          <FormLabel>Slug</FormLabel>
          <FormControl>
            <Input placeholder="forsikringsspecialist" className="font-mono text-sm" data-testid="input-expert-slug" {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )} />
      <div className="grid grid-cols-2 gap-3">
        <FormField control={form.control} name="departmentId" render={({ field }) => (
          <FormItem>
            <FormLabel>Afdeling (valgfri)</FormLabel>
            <Select onValueChange={field.onChange} value={field.value ?? ""}>
              <FormControl>
                <SelectTrigger data-testid="select-expert-department">
                  <SelectValue placeholder="Vælg afdeling" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="none">Ingen</SelectItem>
                {depts.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormItem>
        )} />
        <FormField control={form.control} name="language" render={({ field }) => (
          <FormItem>
            <FormLabel>Sprog</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger data-testid="select-expert-language">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormItem>
        )} />
      </div>
      <FormField control={form.control} name="description" render={({ field }) => (
        <FormItem>
          <FormLabel>Beskrivelse (valgfri)</FormLabel>
          <FormControl>
            <Textarea placeholder="Hvad gør denne AI ekspert?" rows={3} data-testid="input-expert-description" {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )} />
    </div>
  );
}

// ─── Step 2: Forbedr med AI ───────────────────────────────────────────────────

function Step2({
  suggestion,
  onSuggest,
  onAccept,
  isLoading,
}: {
  suggestion: AiSuggestion | null;
  onSuggest: (raw: string) => void;
  onAccept: (s: AiSuggestion) => void;
  isLoading: boolean;
}) {
  const [raw, setRaw] = useState("");

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Beskriv frit hvad eksperten skal gøre — AI'en forbedrer og strukturerer det for dig. Dette trin er valgfrit.
      </p>
      <div className="space-y-2">
        <Textarea
          placeholder="f.eks. Jeg vil have en ekspert der kan hjælpe vores salgsteam med at vurdere kunders kreditværdighed baseret på vores interne retningslinjer og historiske data..."
          rows={4}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          data-testid="input-ai-raw-description"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => onSuggest(raw)}
          disabled={!raw.trim() || isLoading}
          className="w-full border-primary/30 text-primary hover:bg-primary/5"
          data-testid="button-ai-suggest"
        >
          {isLoading ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyserer...</>
          ) : (
            <><Sparkles className="w-4 h-4 mr-2" />Forbedr med AI</>
          )}
        </Button>
      </div>

      {suggestion && (
        <div
          className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3"
          data-testid="ai-suggestion-result"
        >
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-primary">AI forslag</span>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-0.5 uppercase tracking-wide font-bold">Navn</p>
            <p className="text-sm font-medium text-foreground">{suggestion.improvedTitle}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5 uppercase tracking-wide font-bold">Beskrivelse</p>
            <p className="text-sm text-foreground">{suggestion.improvedDescription}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-bold">Ansvarsområder</p>
            <ul className="space-y-1">
              {suggestion.responsibilities.map((r, i) => (
                <li key={i} className="text-xs text-foreground flex items-start gap-1.5">
                  <CheckCircle2 className="w-3 h-3 text-primary mt-0.5 shrink-0" />{r}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-bold">Regelkategorier</p>
              <div className="flex flex-wrap gap-1">
                {suggestion.suggestedRuleThemes.map((t, i) => (
                  <Badge key={i} variant="outline" className="text-xs border-amber-500/30 text-amber-400 bg-amber-500/5">{t}</Badge>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide font-bold">Datatyper</p>
              <div className="flex flex-wrap gap-1">
                {suggestion.suggestedDataTypes.map((t, i) => (
                  <Badge key={i} variant="outline" className="text-xs border-blue-500/30 text-blue-400 bg-blue-500/5">{t}</Badge>
                ))}
              </div>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => onAccept(suggestion)}
            className="w-full mt-1"
            data-testid="button-accept-suggestion"
          >
            <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
            Anvend forslag
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Step 3: Viden & Data ─────────────────────────────────────────────────────

function Step3({
  sources,
  onAdd,
  onRemove,
}: {
  sources: PendingSource[];
  onAdd: (s: PendingSource) => void;
  onRemove: (i: number) => void;
}) {
  const [name, setName]  = useState("");
  const [type, setType]  = useState<PendingSource["sourceType"]>("document");

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd({ sourceName: name.trim(), sourceType: type });
    setName("");
    setType("document");
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tilknyt de datakilder eksperten skal arbejde ud fra. Du kan tilføje dokumenter, politikker, lovgivning og interne regler.
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
          <SelectTrigger className="w-40" data-testid="select-source-type">
            <SelectValue />
          </SelectTrigger>
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
            <div
              key={i}
              className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/10 px-3 py-2"
              data-testid={`source-item-${i}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="text-sm truncate">{s.sourceName}</span>
                <Badge variant="outline" className="text-xs border-blue-500/30 text-blue-400 shrink-0">
                  {SOURCE_TYPE_LABELS[s.sourceType]}
                </Badge>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => onRemove(i)}
                data-testid={`remove-source-${i}`}
              >
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

function Step4({
  rules,
  onAdd,
  onRemove,
}: {
  rules: PendingRule[];
  onAdd: (r: PendingRule) => void;
  onRemove: (i: number) => void;
}) {
  const [type, setType]  = useState<PendingRule["type"]>("decision");
  const [name, setName]  = useState("");
  const [desc, setDesc]  = useState("");

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd({ type, name: name.trim(), description: desc.trim() });
    setName(""); setDesc("");
  };

  const RULE_TYPE_COLORS: Record<string, string> = {
    decision:           "text-amber-400 border-amber-500/30 bg-amber-500/5",
    threshold:          "text-blue-400 border-blue-500/30 bg-blue-500/5",
    required_evidence:  "text-green-400 border-green-500/30 bg-green-500/5",
    source_restriction: "text-rose-400 border-rose-500/30 bg-rose-500/5",
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Definer hvilke regler eksperten skal følge. Regler styrer ekspertens beslutninger, krav til dokumentation og kildeadgang.
      </p>

      <div className="space-y-2">
        <Select value={type} onValueChange={(v) => setType(v as PendingRule["type"])}>
          <SelectTrigger data-testid="select-rule-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(RULE_TYPE_LABELS).map(([v, l]) => (
              <SelectItem key={v} value={v}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
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
        <Button
          type="button"
          variant="outline"
          onClick={handleAdd}
          disabled={!name.trim()}
          className="w-full"
          data-testid="button-add-rule"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Tilføj regel
        </Button>
      </div>

      {rules.length === 0 ? (
        <div className="text-center py-6 rounded-xl border border-dashed border-border/40">
          <Scale className="w-6 h-6 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground/50">Ingen regler tilføjet endnu</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((r, i) => (
            <div
              key={i}
              className="flex items-start justify-between rounded-lg border border-border/40 bg-muted/10 px-3 py-2.5"
              data-testid={`rule-item-${i}`}
            >
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-xs ${RULE_TYPE_COLORS[r.type]}`}>
                    {RULE_TYPE_LABELS[r.type]}
                  </Badge>
                  <span className="text-sm font-medium truncate">{r.name}</span>
                </div>
                {r.description && (
                  <p className="text-xs text-muted-foreground">{r.description}</p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 ml-2"
                onClick={() => onRemove(i)}
                data-testid={`remove-rule-${i}`}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Step 5: Test Ekspert ─────────────────────────────────────────────────────

function Step5({
  expertName,
  sources,
  rules,
  testQuery,
  onQueryChange,
  onRunTest,
  testResponse,
  isTesting,
}: {
  expertName: string;
  sources: PendingSource[];
  rules: PendingRule[];
  testQuery: string;
  onQueryChange: (v: string) => void;
  onRunTest: () => void;
  testResponse: string | null;
  isTesting: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/40 bg-muted/5 p-4 space-y-3">
        <p className="text-xs text-muted-foreground uppercase tracking-wide font-bold mb-2">Opsummering</p>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Brain className="w-5 h-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">{expertName || "Unavngivet ekspert"}</p>
            <p className="text-xs text-muted-foreground">Klar til oprettelse</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <BookOpen className="w-3.5 h-3.5 text-blue-400" />
            <span>{sources.length} datakilde{sources.length !== 1 ? "r" : ""}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Scale className="w-3.5 h-3.5 text-amber-400" />
            <span>{rules.length} regel{rules.length !== 1 ? "r" : ""}</span>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Prøv eksperten af med et eksempel, før den sættes i brug.
        </p>
        <Textarea
          placeholder="f.eks. Kan vi godkende en kredit på 300.000 kr. til en kunde med en kreditvurdering på B+?"
          rows={3}
          value={testQuery}
          onChange={(e) => onQueryChange(e.target.value)}
          data-testid="input-test-query"
        />
        <Button
          type="button"
          variant="outline"
          onClick={onRunTest}
          disabled={!testQuery.trim() || isTesting}
          className="w-full"
          data-testid="button-run-test"
        >
          {isTesting ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Tester...</>
          ) : (
            <><PlayCircle className="w-4 h-4 mr-2" />Kør test</>
          )}
        </Button>
      </div>

      {testResponse && (
        <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4" data-testid="test-response">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-4 h-4 text-green-400" />
            <span className="text-xs font-semibold text-green-400">Ekspertsvar</span>
          </div>
          <p className="text-sm text-foreground whitespace-pre-wrap">{testResponse}</p>
        </div>
      )}
    </div>
  );
}

// ─── Create Wizard Dialog ─────────────────────────────────────────────────────

function CreateWizard({
  open,
  onClose,
  depts,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  depts: DeptRow[];
  onCreated: () => void;
}) {
  const { toast }          = useToast();
  const [step, setStep]    = useState(1);
  const TOTAL_STEPS        = 5;

  const form = useForm<Step1Values>({
    resolver: zodResolver(step1Schema),
    defaultValues: { name: "", slug: "", description: "", departmentId: "", language: "da" },
  });

  const [suggestion, setSuggestion]   = useState<AiSuggestion | null>(null);
  const [sources, setSources]         = useState<PendingSource[]>([]);
  const [rules, setRules]             = useState<PendingRule[]>([]);
  const [testQuery, setTestQuery]     = useState("");
  const [testResponse, setTestResponse] = useState<string | null>(null);

  const aiSuggestMutation = useMutation({
    mutationFn: (rawDescription: string) =>
      apiRequest<AiSuggestion>("POST", "/api/experts/ai-suggest", { rawDescription }),
    onSuccess: (data) => setSuggestion(data),
    onError:   (err: ApiError | Error) =>
      toast({ title: "AI fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: (query: string) =>
      apiRequest<{ content: string }>("POST", "/api/experts/ai-suggest", {
        rawDescription: `TEST FORESPØRGSEL for ekspert "${form.watch("name")}": ${query}`,
      }),
    onSuccess: (data) => {
      const d = data as unknown as { improvedDescription?: string };
      setTestResponse(d.improvedDescription ?? JSON.stringify(data, null, 2));
    },
    onError: () => setTestResponse("Test svarede ikke — eksperten oprettes alligevel."),
  });

  const createMutation = useMutation({
    mutationFn: async (values: Step1Values) => {
      const profile = await apiRequest<ExpertRow>("POST", "/api/architectures", {
        name:         values.name,
        slug:         values.slug,
        description:  values.description || undefined,
        category:     undefined,
        departmentId: values.departmentId === "none" ? undefined : values.departmentId || undefined,
        language:     values.language,
      });
      await Promise.all([
        ...sources.map((s) => apiRequest("POST", `/api/architectures/${profile.id}/sources`, s)),
        ...rules.map((r)   => apiRequest("POST", `/api/architectures/${profile.id}/rules`,   r)),
      ]);
      return profile;
    },
    onSuccess: () => {
      toast({ title: "AI ekspert oprettet" });
      invalidate(["/api/architectures"]);
      handleClose();
      onCreated();
    },
    onError: (err: ApiError | Error) =>
      toast({ title: "Fejl", description: friendlyError(err), variant: "destructive" }),
  });

  const handleClose = () => {
    onClose();
    setTimeout(() => {
      setStep(1); setSuggestion(null); setSources([]); setRules([]);
      setTestQuery(""); setTestResponse(null);
      form.reset();
    }, 300);
  };

  const handleAcceptSuggestion = (s: AiSuggestion) => {
    form.setValue("name", s.improvedTitle, { shouldValidate: true });
    form.setValue("description", s.improvedDescription);
    const slug = s.improvedTitle
      .toLowerCase()
      .replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    form.setValue("slug", slug);
    toast({ title: "Forslag anvendt", description: "Grundoplysningerne er opdateret." });
  };

  const canGoNext = async () => {
    if (step === 1) {
      const valid = await form.trigger(["name", "slug"]);
      return valid;
    }
    return true;
  };

  const handleNext = async () => {
    if (await canGoNext()) setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  };

  const handleBack = () => setStep((s) => Math.max(s - 1, 1));

  const handleSubmit = () => {
    form.handleSubmit((v) => createMutation.mutate(v))();
  };

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
            <StepIndicator current={step} total={TOTAL_STEPS} />

            <Form {...form}>
              <form onSubmit={(e) => e.preventDefault()}>
                {step === 1 && <Step1 form={form} depts={depts} />}
                {step === 2 && (
                  <Step2
                    suggestion={suggestion}
                    onSuggest={(raw) => aiSuggestMutation.mutate(raw)}
                    onAccept={handleAcceptSuggestion}
                    isLoading={aiSuggestMutation.isPending}
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
                {step === 5 && (
                  <Step5
                    expertName={form.watch("name")}
                    sources={sources}
                    rules={rules}
                    testQuery={testQuery}
                    onQueryChange={setTestQuery}
                    onRunTest={() => testMutation.mutate(testQuery)}
                    testResponse={testResponse}
                    isTesting={testMutation.isPending}
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
            onClick={step === 1 ? handleClose : handleBack}
            data-testid="button-wizard-back"
          >
            {step === 1 ? (
              "Annuller"
            ) : (
              <><ChevronLeft className="w-4 h-4 mr-1" />Tilbage</>
            )}
          </Button>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{step} / {TOTAL_STEPS}</span>
            {step < TOTAL_STEPS ? (
              <Button
                type="button"
                onClick={handleNext}
                data-testid="button-wizard-next"
              >
                Næste <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                data-testid="button-submit-create-expert"
              >
                {createMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />Opretter...</>
                ) : (
                  <><CheckCircle2 className="w-4 h-4 mr-1.5" />Opret ekspert</>
                )}
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
  const { toast }          = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data: experts, isLoading } = useQuery<ExpertRow[]>({
    queryKey: ["/api/architectures"],
    ...QUERY_POLICY.list,
  });

  const { data: depts = [] } = useQuery<DeptRow[]>({
    queryKey: ["/api/tenant/departments"],
    ...QUERY_POLICY.list,
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/architectures/${id}/archive`, {}),
    onSuccess:  () => { toast({ title: "Ekspert arkiveret" }); invalidate(["/api/architectures"]); },
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
        <Button
          onClick={() => setShowCreate(true)}
          data-testid="button-create-expert"
          className="shrink-0"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Opret ekspert
        </Button>
      </div>

      {/* Expert list */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : active.length === 0 ? (
        <div className="text-center py-20 space-y-4">
          <div
            className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)" }}
          >
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
            <Plus className="w-4 h-4 mr-1.5" />
            Opret AI ekspert
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {active.map((e) => (
              <ExpertCard
                key={e.id}
                expert={e}
                depts={depts}
                onArchive={(id) => archiveMutation.mutate(id)}
              />
            ))}
          </div>

          {archived.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground/50 uppercase tracking-widest font-bold mb-3">
                Arkiverede
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 opacity-50">
                {archived.map((e) => (
                  <ExpertCard key={e.id} expert={e} depts={depts} onArchive={() => {}} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Wizard */}
      <CreateWizard
        open={showCreate}
        onClose={() => setShowCreate(false)}
        depts={depts}
        onCreated={() => invalidate(["/api/architectures"])}
      />
    </div>
  );
}
