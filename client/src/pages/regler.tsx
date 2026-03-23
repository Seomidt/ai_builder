/**
 * Regler — Tenant Product Page
 *
 * Define constraints, business logic, policy enforcement and AI guardrails.
 * Shell page — rule configuration model will be wired as the backend matures.
 */

import { useState } from "react";
import { Scale, Plus, ShieldCheck, AlertCircle, Lock, Percent } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// ── Example rule types (UI model) ─────────────────────────────────────────────

const RULE_TYPE_CONFIG = {
  decision: { label: "Beslutningsregel", icon: ShieldCheck, color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/25" },
  limit:    { label: "Grænseværdi",      icon: Percent,     color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/25" },
  required: { label: "Krav",             icon: Lock,         color: "text-red-400",   bg: "bg-red-500/10",   border: "border-red-500/25"   },
  source:   { label: "Kildebegrænsning", icon: AlertCircle,  color: "text-slate-400", bg: "bg-slate-500/10", border: "border-slate-500/25"  },
} as const;

type RuleType = keyof typeof RULE_TYPE_CONFIG;

interface Rule {
  id: string;
  name: string;
  description: string;
  type: RuleType;
  status: "active" | "draft";
}

// ── Seed examples ─────────────────────────────────────────────────────────────

const EXAMPLE_RULES: Rule[] = [
  {
    id: "1",
    name: "Maks. udbetaling 50.000 kr.",
    description: "AI må ikke godkende udbetalinger over 50.000 kr. uden manuel godkendelse.",
    type: "limit",
    status: "active",
  },
  {
    id: "2",
    name: "Dokumentation påkrævet",
    description: "Skadesanmeldelser kræver altid minimum ét vedlagt dokument.",
    type: "required",
    status: "active",
  },
  {
    id: "3",
    name: "Brug kun godkendte datakilder",
    description: "AI eksperter må kun svare ud fra datakilder der er mærket 'godkendt'.",
    type: "source",
    status: "draft",
  },
];

function RuleCard({ rule }: { rule: Rule }) {
  const cfg = RULE_TYPE_CONFIG[rule.type];
  const Icon = cfg.icon;
  return (
    <Card
      data-testid={`rule-card-${rule.id}`}
      className={`bg-card border-card-border hover:border-primary/20 transition-all duration-200`}
    >
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start gap-3">
          <div className={`flex items-center justify-center w-8 h-8 rounded-lg shrink-0 ${cfg.bg} border ${cfg.border}`}>
            <Icon className={`w-4 h-4 ${cfg.color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-sm font-semibold text-card-foreground">{rule.name}</span>
              <Badge
                variant="outline"
                className={`text-[10px] ${cfg.color} ${cfg.border} ${cfg.bg}`}
              >
                {cfg.label}
              </Badge>
              <Badge
                variant="outline"
                className={`text-[10px] ${
                  rule.status === "active"
                    ? "text-green-400 border-green-500/30 bg-green-500/10"
                    : "text-slate-400 border-slate-500/30"
                }`}
              >
                {rule.status === "active" ? "Aktiv" : "Kladde"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{rule.description}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Regler() {
  const [showCreate, setShowCreate] = useState(false);
  const [rules] = useState<Rule[]>(EXAMPLE_RULES);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newType, setNewType] = useState<RuleType>("decision");

  const active = rules.filter((r) => r.status === "active");
  const drafts  = rules.filter((r) => r.status === "draft");

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl" data-testid="page-regler">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{
                background: "rgba(99,102,241,0.10)",
                border: "1px solid rgba(99,102,241,0.20)",
              }}
            >
              <Scale className="w-4 h-4 text-indigo-400" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-page-title">
              Regler
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Definér regler og begrænsninger, så AI følger jeres forretningslogik og politikker.
          </p>
        </div>
        <Button
          onClick={() => setShowCreate(true)}
          data-testid="button-create-rule"
          className="shrink-0"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Ny regel
        </Button>
      </div>

      {/* Rule type overview */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(Object.entries(RULE_TYPE_CONFIG) as [RuleType, typeof RULE_TYPE_CONFIG[RuleType]][]).map(([key, cfg]) => {
          const Icon = cfg.icon;
          const count = rules.filter((r) => r.type === key).length;
          return (
            <Card key={key} className={`bg-card border-card-border`}>
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2">
                  <div className={`w-7 h-7 rounded-md flex items-center justify-center ${cfg.bg} border ${cfg.border}`}>
                    <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                  </div>
                  <div>
                    <p className={`text-sm font-bold tabular-nums ${cfg.color}`}>{count}</p>
                    <p className="text-[10px] text-muted-foreground/60 leading-tight">{cfg.label}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Rules list */}
      {active.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground/50 pb-1">
            Aktive regler
          </p>
          {active.map((r) => <RuleCard key={r.id} rule={r} />)}
        </div>
      )}

      {drafts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground/50 pb-1">
            Kladder
          </p>
          <div className="opacity-60">
            {drafts.map((r) => <RuleCard key={r.id} rule={r} />)}
          </div>
        </div>
      )}

      {rules.length === 0 && (
        <div className="text-center py-20 space-y-4">
          <div
            className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.15)" }}
          >
            <Scale className="w-7 h-7 text-indigo-400/60" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground mb-1">Ingen regler endnu</p>
            <p className="text-sm text-muted-foreground">
              Opret din første regel — f.eks. en grænseværdi for AI beslutninger.
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)} data-testid="button-empty-create-rule">
            <Plus className="w-4 h-4 mr-1.5" />
            Opret regel
          </Button>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scale className="w-4 h-4 text-indigo-400" />
              Opret regel
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Navn</Label>
              <Input
                placeholder="f.eks. Maks. udbetaling 50.000 kr."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                data-testid="input-rule-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={newType} onValueChange={(v) => setNewType(v as RuleType)}>
                <SelectTrigger data-testid="select-rule-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(RULE_TYPE_CONFIG) as [RuleType, typeof RULE_TYPE_CONFIG[RuleType]][]).map(([key, cfg]) => (
                    <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Beskrivelse</Label>
              <Textarea
                placeholder="Beskriv hvad denne regel gør..."
                rows={3}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                data-testid="input-rule-description"
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button
              variant="ghost"
              onClick={() => { setShowCreate(false); setNewName(""); setNewDesc(""); }}
            >
              Annuller
            </Button>
            <Button
              disabled={!newName.trim()}
              onClick={() => setShowCreate(false)}
              data-testid="button-submit-create-rule"
            >
              Gem regel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
