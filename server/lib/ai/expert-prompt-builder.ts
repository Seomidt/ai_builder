/**
 * expert-prompt-builder.ts
 *
 * Centralized, deterministic prompt assembly for AI Expert test execution.
 *
 * Never scatter prompt logic inline across routes.
 * All AI Expert system-prompt construction flows through this module.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExpertConfig {
  name:           string;
  goal:           string | null;
  instructions:   string | null;
  outputStyle:    string | null;
  language:       string | null;
  modelProvider:  string | null;
  modelName:      string | null;
  temperature:    number | null;
  maxOutputTokens: number | null;
}

export interface RuleEntry {
  id:              string;
  type:            string;
  name:            string;
  description:     string | null;
  priority:        number;
  enforcementLevel: string; // hard | soft
}

export interface SourceEntry {
  id:         string;
  sourceName: string;
  sourceType: string;
  status:     string;
}

export interface BuiltPrompt {
  systemPrompt:    string;
  usedRules:       RuleEntry[];
  usedSources:     SourceEntry[];
  modelProvider:   string;
  modelName:       string;
  temperature:     number;
  maxOutputTokens: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const SUPPORTED_PROVIDERS = ["openai"] as const;
const SUPPORTED_MODELS    = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"] as const;

const DEFAULTS = {
  modelProvider:   "openai" as string,
  modelName:       "gpt-4o" as string,
  temperature:     0.3,
  maxOutputTokens: 2048,
};

const TEMP_FLOOR  = 0.0;
const TEMP_CEIL   = 1.0;
const TOKEN_FLOOR = 256;
const TOKEN_CEIL  = 4096;

// ─── Model config validation ──────────────────────────────────────────────────

export function resolveModelConfig(expert: ExpertConfig): {
  provider: string; model: string; temperature: number; maxTokens: number;
} {
  const provider = SUPPORTED_PROVIDERS.includes(expert.modelProvider as (typeof SUPPORTED_PROVIDERS)[number])
    ? (expert.modelProvider as string)
    : DEFAULTS.modelProvider;

  const model = SUPPORTED_MODELS.includes(expert.modelName as (typeof SUPPORTED_MODELS)[number])
    ? (expert.modelName as string)
    : DEFAULTS.modelName;

  const temperature = typeof expert.temperature === "number"
    ? Math.min(TEMP_CEIL, Math.max(TEMP_FLOOR, expert.temperature))
    : DEFAULTS.temperature;

  const maxTokens = typeof expert.maxOutputTokens === "number"
    ? Math.min(TOKEN_CEIL, Math.max(TOKEN_FLOOR, expert.maxOutputTokens))
    : DEFAULTS.maxOutputTokens;

  return { provider, model, temperature, maxTokens };
}

// ─── Rule section builder ─────────────────────────────────────────────────────

function buildRuleSection(rules: RuleEntry[]): string {
  if (rules.length === 0) return "";

  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  const hardRules = sorted.filter((r) => r.enforcementLevel === "hard");
  const softRules = sorted.filter((r) => r.enforcementLevel !== "hard");

  const lines: string[] = ["## Regler og begrænsninger\n"];

  if (hardRules.length > 0) {
    lines.push("### UFRAVIGELIGE REGLER (skal altid overholdes)\n");
    for (const r of hardRules) {
      lines.push(`- [${r.type.toUpperCase()}] **${r.name}**${r.description ? `: ${r.description}` : ""}`);
    }
    lines.push("");
  }

  if (softRules.length > 0) {
    lines.push("### Vejledende regler (følg medmindre stærke grunde taler imod)\n");
    for (const r of softRules) {
      lines.push(`- [${r.type.toUpperCase()}] ${r.name}${r.description ? `: ${r.description}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Source section builder ───────────────────────────────────────────────────

function buildSourceSection(sources: SourceEntry[]): string {
  if (sources.length === 0) return "";

  const active = sources.filter((s) => s.status !== "failed");
  if (active.length === 0) return "";

  const lines = ["## Tilgængelige datakilder\n"];
  lines.push("Du har adgang til følgende datakilder. Basér dine svar primært på disse:\n");

  for (const s of active) {
    const statusNote = s.status === "processed" ? " ✓" : s.status === "pending" ? " (behandles)" : "";
    lines.push(`- **${s.sourceName}** [${s.sourceType}]${statusNote}`);
  }
  lines.push("");
  lines.push("Citér eller henvis til relevante kilder i dit svar, når det er muligt.\n");

  return lines.join("\n");
}

// ─── Output style section ─────────────────────────────────────────────────────

function buildOutputStyleSection(style: string | null, language: string | null): string {
  const lang = language === "en" ? "English" : "dansk";

  const styleMap: Record<string, string> = {
    concise:  "Giv korte, præcise svar uden unødvendige omsvøb.",
    formal:   "Skriv i en formel, professionel tone.",
    advisory: "Giv rådgivende, velovervejet respons. Angiv altid grunder og forbehold.",
  };

  const styleInstruction = style && styleMap[style]
    ? styleMap[style]
    : "Giv klare, handlingsorienterede svar.";

  return `## Format og stil\n\n${styleInstruction}\nSvar på ${lang}.\n`;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export function buildExpertPrompt(
  expert:  ExpertConfig,
  rules:   RuleEntry[],
  sources: SourceEntry[],
): BuiltPrompt {
  const modelCfg = resolveModelConfig(expert);

  const sections: string[] = [];

  // 1. Identity + goal
  const identity = [
    `Du er **${expert.name}** — en specialiseret AI ekspert.`,
    expert.goal ? `\n**Formål:** ${expert.goal}` : "",
  ].join("");
  sections.push(identity);

  // 2. Custom instructions (highest authority)
  if (expert.instructions?.trim()) {
    sections.push(`## Instruktioner\n\n${expert.instructions.trim()}`);
  }

  // 3. Rules section
  const ruleSection = buildRuleSection(rules);
  if (ruleSection) sections.push(ruleSection);

  // 4. Source section
  const sourceSection = buildSourceSection(sources);
  if (sourceSection) sections.push(sourceSection);

  // 5. Output style
  sections.push(buildOutputStyleSection(expert.outputStyle, expert.language));

  // 6. Safety footer
  sections.push(
    "## Sikkerhed\n\n" +
    "Overskrid aldrig dine ufravigelige regler. " +
    "Hvis du er i tvivl eller mangler tilstrækkelig dokumentation, " +
    "angiv dette eksplicit og eskalér til en menneskelig operatør.",
  );

  const systemPrompt = sections.join("\n\n").trim();

  return {
    systemPrompt,
    usedRules:       rules,
    usedSources:     sources,
    modelProvider:   modelCfg.provider,
    modelName:       modelCfg.model,
    temperature:     modelCfg.temperature,
    maxOutputTokens: modelCfg.maxTokens,
  };
}
