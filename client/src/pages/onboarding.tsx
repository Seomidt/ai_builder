/**
 * Onboarding — Tenant 5-Step Setup Wizard
 *
 * Guides the first tenant admin through the correct product model:
 * Step 1: Organisation setup
 * Step 2: Opret første AI ekspert
 * Step 3: Tilføj viden / data
 * Step 4: Definér regler
 * Step 5: Invitér team
 */

import { useState } from "react";
import { useLocation } from "wouter";
import {
  Building, Brain, BookOpen, Scale, Users2,
  CheckCircle2, ChevronRight, ChevronLeft, ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import { BrandMark } from "@/components/brand/BrandMark";

// ── Steps config ──────────────────────────────────────────────────────────────

const STEPS = [
  {
    id: 1,
    key: "org",
    label: "Organisation",
    icon: Building,
    title: "Sæt jeres organisation op",
    description: "Giv jeres workspace et navn og opret de første afdelinger.",
    color: "text-primary",
    bg: "rgba(34,211,238,0.10)",
    border: "rgba(34,211,238,0.18)",
  },
  {
    id: 2,
    key: "expert",
    label: "AI Ekspert",
    icon: Brain,
    title: "Opret jeres første AI ekspert",
    description: "Opret en AI specialist — f.eks. en Forsikringsspecialist eller Supportekspert.",
    color: "text-primary",
    bg: "rgba(34,211,238,0.10)",
    border: "rgba(34,211,238,0.18)",
  },
  {
    id: 3,
    key: "data",
    label: "Viden & Data",
    icon: BookOpen,
    title: "Tilføj intern viden og data",
    description: "Upload dokumenter, politikker og videnskilder til jeres AI eksperter.",
    color: "text-secondary",
    bg: "rgba(245,158,11,0.10)",
    border: "rgba(245,158,11,0.18)",
  },
  {
    id: 4,
    key: "rules",
    label: "Regler",
    icon: Scale,
    title: "Definér regler og begrænsninger",
    description: "Sæt forretningsregler og politikker så AI følger jeres processer.",
    color: "text-indigo-400",
    bg: "rgba(99,102,241,0.10)",
    border: "rgba(99,102,241,0.18)",
  },
  {
    id: 5,
    key: "team",
    label: "Team",
    icon: Users2,
    title: "Invitér jeres team",
    description: "Invitér kolleger og tildel dem adgang til de rette eksperter og data.",
    color: "text-primary",
    bg: "rgba(34,211,238,0.10)",
    border: "rgba(34,211,238,0.18)",
  },
] as const;

const PRESET_DEPTS = ["Salg", "Marketing", "Support", "Compliance", "Drift", "Claims"];

// ── Step components ────────────────────────────────────────────────────────────

function OrgStep({
  onChange,
}: {
  onChange: (data: { orgName: string; departments: string[] }) => void;
}) {
  const [orgName, setOrgName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(d: string) {
    const next = selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d];
    setSelected(next);
    onChange({ orgName, departments: next });
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Workspace navn</Label>
        <Input
          placeholder="f.eks. Acme Insurance"
          value={orgName}
          onChange={(e) => {
            setOrgName(e.target.value);
            onChange({ orgName: e.target.value, departments: selected });
          }}
          data-testid="input-org-name"
        />
      </div>
      <div className="space-y-2">
        <Label>Afdelinger (valgfri)</Label>
        <p className="text-xs text-muted-foreground">Vælg de afdelinger der er relevante for jer.</p>
        <div className="flex flex-wrap gap-2 mt-1">
          {PRESET_DEPTS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggle(d)}
              className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                selected.includes(d)
                  ? "bg-primary/15 text-primary border-primary/30"
                  : "bg-muted/20 text-muted-foreground border-white/8 hover:border-white/25"
              }`}
              data-testid={`preset-dept-${d}`}
            >
              {selected.includes(d) && <CheckCircle2 className="w-3 h-3 inline mr-1" />}
              {d}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ExpertStep({
  onChange,
}: {
  onChange: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const EXAMPLES = ["Forsikringsspecialist", "Supportekspert", "Compliance Ekspert", "Salgsassistent"];

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Navn på AI ekspert</Label>
        <Input
          placeholder="f.eks. Forsikringsspecialist"
          value={name}
          onChange={(e) => { setName(e.target.value); onChange(e.target.value); }}
          data-testid="input-onboarding-expert-name"
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Eller vælg et eksempel:</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => { setName(ex); onChange(ex); }}
              className="text-sm px-3 py-1.5 rounded-full border border-white/8 bg-muted/20 text-muted-foreground hover:text-foreground hover:border-white/25 transition-colors"
              data-testid={`example-expert-${ex}`}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DataStep({ onChange }: { onChange: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Navn på datakilde</Label>
        <Input
          placeholder="f.eks. Forsikringsvilkår 2024"
          value={name}
          onChange={(e) => { setName(e.target.value); onChange(e.target.value); }}
          data-testid="input-onboarding-data-name"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Du kan tilføje dokumenter, politikker og intern vidensbase. Upload af filer kan ske via Viden & Data-siden.
      </p>
    </div>
  );
}

function RulesStep({ onChange }: { onChange: (name: string) => void }) {
  const [name, setName] = useState("");
  const EXAMPLES = ["Maks. udbetaling 50.000 kr.", "Dokumentation påkrævet", "Brug kun godkendte kilder"];

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Første regel (valgfri)</Label>
        <Input
          placeholder="f.eks. Maks. udbetaling 50.000 kr."
          value={name}
          onChange={(e) => { setName(e.target.value); onChange(e.target.value); }}
          data-testid="input-onboarding-rule-name"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => { setName(ex); onChange(ex); }}
            className="text-xs px-2.5 py-1 rounded-full border border-white/8 bg-muted/20 text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors"
          >
            {ex}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Du kan springe dette trin over og definere regler fra Regler-siden.
      </p>
    </div>
  );
}

function TeamStep({ onChange }: { onChange: (email: string) => void }) {
  const [email, setEmail] = useState("");
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label>Invitér første kollega (valgfri)</Label>
        <Input
          type="email"
          placeholder="kollega@virksomhed.dk"
          value={email}
          onChange={(e) => { setEmail(e.target.value); onChange(e.target.value); }}
          data-testid="input-onboarding-invite-email"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Du kan invitere hele dit team fra Team-siden og tildele detaljerede adgangsrettigheder.
      </p>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [completed, setCompleted] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const [orgData, setOrgData] = useState<{ orgName: string; departments: string[] }>({
    orgName: "",
    departments: [],
  });
  const [expertName, setExpertName] = useState("");
  const [dataName, setDataName] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");

  const currentStep = STEPS[step];
  const isLast = step === STEPS.length - 1;

  async function handleNext() {
    setLoading(true);
    try {
      if (step === 0 && orgData.departments.length > 0) {
        // Create departments
        for (const dept of orgData.departments) {
          await apiRequest("POST", "/api/tenant/departments", {
            name: dept,
            slug: dept.toLowerCase().replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa").replace(/[^a-z0-9]+/g, "-"),
          }).catch(() => null);
        }
      }
      if (step === 1 && expertName.trim()) {
        const slug = expertName.toLowerCase().replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa").replace(/[^a-z0-9]+/g, "-");
        await apiRequest("POST", "/api/architectures", { name: expertName, slug }).catch(() => null);
      }
      if (step === 2 && dataName.trim()) {
        const slug = dataName.toLowerCase().replace(/[æ]/g, "ae").replace(/[ø]/g, "oe").replace(/[å]/g, "aa").replace(/[^a-z0-9]+/g, "-");
        await apiRequest("POST", "/api/projects", { name: dataName, slug }).catch(() => null);
      }
      if (step === 4 && inviteEmail.trim()) {
        await apiRequest("POST", "/api/tenant/team/invite", { email: inviteEmail, role: "member" }).catch(() => null);
      }

      setCompleted((prev) => new Set([...prev, step]));

      if (isLast) {
        toast({ title: "Opsætning fuldført!", description: "Jeres AI ekspert platform er klar." });
        setLocation("/");
      } else {
        setStep((s) => s + 1);
      }
    } catch (err) {
      toast({ title: "Fejl", description: friendlyError(err as Error), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4" style={{ backgroundColor: "hsl(218 32% 8%)" }}>
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <BrandMark size={32} />
          <span className="text-lg font-bold text-white tracking-tight">BlissOps</span>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-1.5 mb-8">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const done = completed.has(i);
            const active = i === step;
            return (
              <div key={s.id} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className={`h-1 w-full rounded-full transition-all duration-300 ${
                    done ? "bg-primary" : active ? "bg-primary/50" : "bg-white/10"
                  }`}
                />
                <div className="flex items-center gap-1">
                  {done ? (
                    <CheckCircle2 className="w-3 h-3 text-primary" />
                  ) : (
                    <div className={`w-3 h-3 rounded-full border ${active ? "border-primary bg-primary/20" : "border-white/20"}`} />
                  )}
                  <span className={`text-[9px] font-medium hidden sm:block ${active ? "text-foreground" : "text-muted-foreground/50"}`}>
                    {s.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Step card */}
        <Card className="bg-card border-card-border">
          <CardContent className="pt-6 pb-6">
            {/* Step header */}
            <div className="flex items-center gap-3 mb-6">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: currentStep.bg, border: `1px solid ${currentStep.border}` }}
              >
                <currentStep.icon className={`w-5 h-5 ${currentStep.color}`} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-foreground">{currentStep.title}</h2>
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    {step + 1}/{STEPS.length}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{currentStep.description}</p>
              </div>
            </div>

            {/* Step content */}
            {step === 0 && <OrgStep onChange={setOrgData} />}
            {step === 1 && <ExpertStep onChange={setExpertName} />}
            {step === 2 && <DataStep onChange={setDataName} />}
            {step === 3 && <RulesStep onChange={setRuleName} />}
            {step === 4 && <TeamStep onChange={setInviteEmail} />}

            {/* Navigation */}
            <div className="flex justify-between items-center mt-8">
              <Button
                variant="ghost"
                onClick={() => step > 0 ? setStep((s) => s - 1) : setLocation("/")}
                data-testid="button-onboarding-back"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                {step === 0 ? "Spring over" : "Tilbage"}
              </Button>
              <Button
                onClick={handleNext}
                disabled={loading}
                data-testid="button-onboarding-next"
              >
                {loading ? "Gemmer..." : isLast ? (
                  <>Kom i gang <ArrowRight className="w-4 h-4 ml-1.5" /></>
                ) : (
                  <>Næste <ChevronRight className="w-4 h-4 ml-1" /></>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground/40 mt-4">
          Du kan altid ændre disse indstillinger fra Workspace-siden.
        </p>
      </div>
    </div>
  );
}
