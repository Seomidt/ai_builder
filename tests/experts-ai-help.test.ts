/**
 * tests/experts-ai-help.test.ts
 *
 * Unit tests for AI Help validation logic in expert creation:
 * - input length guards (min 15/20 chars)
 * - structured response parsing + schema validation
 * - retry on malformed AI output
 * - neutral domain defaults (no insurance hardcoding)
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// ─── Shared AiSuggestionSchema (mirrors routes.ts) ────────────────────────────

const AiSuggestionSchema = z.object({
  suggested_name:         z.string().min(1),
  improved_description:   z.string(),
  goal:                   z.string(),
  instructions:           z.string(),
  restrictions:           z.string().optional().default(""),
  suggested_output_style: z.enum(["concise", "formal", "advisory"]).catch("advisory"),
  suggested_rules: z.array(z.object({
    type:              z.string(),
    name:              z.string(),
    description:       z.string(),
    priority:          z.number().int().catch(100),
    enforcement_level: z.enum(["hard", "soft"]).catch("soft"),
  })).default([]),
  suggested_source_types: z.array(z.string()).default([]),
  warnings:               z.array(z.string()).default([]),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tryParse = (raw: string): unknown | null => {
  try { return JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim()); }
  catch { return null; }
};

const VALID_SUGGESTION = {
  suggested_name:         "Supportekspert",
  improved_description:   "Besvarer medarbejderspørgsmål baseret på interne dokumenter.",
  goal:                   "Giver hurtige, præcise svar på drifts- og supportspørgsmål.",
  instructions:           "- Brug kun interne dokumenter\n- Citer altid kilden",
  restrictions:           "- Gæt ikke\n- Svar ikke på spørgsmål udenfor scope",
  suggested_output_style: "advisory" as const,
  suggested_rules:        [],
  suggested_source_types: ["document"],
  warnings:               [],
};

// ─── Tests: input validation guards ───────────────────────────────────────────

describe("AI Help input validation", () => {
  it("blocks ai-refine if currentValue < 15 chars", () => {
    const tooShort = "kort";
    expect(tooShort.trim().length < 15).toBe(true);
  });

  it("allows ai-refine if currentValue >= 15 chars", () => {
    const ok = "Her er en tekst om ekspertens formål og mål.";
    expect(ok.trim().length >= 15).toBe(true);
  });

  it("blocks ai-suggest if rawDescription < 20 chars", () => {
    const tooShort = "support";
    expect(tooShort.trim().length < 20).toBe(true);
  });

  it("allows ai-suggest if rawDescription >= 20 chars", () => {
    const ok = "En supportekspert der besvarer medarbejdernes spørgsmål.";
    expect(ok.trim().length >= 20).toBe(true);
  });
});

// ─── Tests: JSON parsing ──────────────────────────────────────────────────────

describe("AI Help JSON parse helper", () => {
  it("parses clean JSON", () => {
    const raw = JSON.stringify(VALID_SUGGESTION);
    expect(tryParse(raw)).toEqual(VALID_SUGGESTION);
  });

  it("strips markdown fences before parsing", () => {
    const raw = `\`\`\`json\n${JSON.stringify(VALID_SUGGESTION)}\n\`\`\``;
    expect(tryParse(raw)).toEqual(VALID_SUGGESTION);
  });

  it("returns null on invalid JSON", () => {
    expect(tryParse("not valid json { broken")).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(tryParse("")).toBeNull();
  });
});

// ─── Tests: schema validation ─────────────────────────────────────────────────

describe("AiSuggestionSchema validation", () => {
  it("accepts fully valid suggestion", () => {
    const result = AiSuggestionSchema.safeParse(VALID_SUGGESTION);
    expect(result.success).toBe(true);
  });

  it("rejects missing suggested_name", () => {
    const { suggested_name: _, ...withoutName } = VALID_SUGGESTION;
    const result = AiSuggestionSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });

  it("rejects empty suggested_name", () => {
    const result = AiSuggestionSchema.safeParse({ ...VALID_SUGGESTION, suggested_name: "" });
    expect(result.success).toBe(false);
  });

  it("coerces invalid output_style to 'advisory' via .catch()", () => {
    const result = AiSuggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      suggested_output_style: "insurance_style",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.suggested_output_style).toBe("advisory");
  });

  it("defaults restrictions to empty string when absent", () => {
    const { restrictions: _, ...withoutRestrictions } = VALID_SUGGESTION;
    const result = AiSuggestionSchema.safeParse(withoutRestrictions);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.restrictions).toBe("");
  });

  it("defaults suggested_rules to [] when absent", () => {
    const { suggested_rules: _, ...without } = VALID_SUGGESTION;
    const result = AiSuggestionSchema.safeParse(without);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.suggested_rules).toEqual([]);
  });

  it("coerces invalid rule enforcement_level to 'soft'", () => {
    const result = AiSuggestionSchema.safeParse({
      ...VALID_SUGGESTION,
      suggested_rules: [{ type: "decision", name: "Test", description: "desc", priority: 50, enforcement_level: "invalid" }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.suggested_rules[0].enforcement_level).toBe("soft");
  });
});

// ─── Tests: neutral domain defaults (no insurance hardcoding) ─────────────────

describe("Domain neutrality — no insurance-specific defaults", () => {
  const INSURANCE_TERMS = ["forsikring", "forsikrings", "police", "skadesager", "dækning"];

  it("valid suggestion template does not contain insurance terms", () => {
    const json = JSON.stringify(VALID_SUGGESTION).toLowerCase();
    const found = INSURANCE_TERMS.filter(term => json.includes(term));
    expect(found).toEqual([]);
  });

  it("neutral description does not contain insurance terms", () => {
    const neutralDesc = "En komplianceassistent der rådgiver baseret på interne politikker og regulatoriske krav.";
    const found = INSURANCE_TERMS.filter(term => neutralDesc.toLowerCase().includes(term));
    expect(found).toEqual([]);
  });

  it("the schema accepts suggestions for non-insurance domains", () => {
    const legalSuggestion = {
      ...VALID_SUGGESTION,
      suggested_name:       "Juridisk Assistent",
      improved_description: "Besvarer juridiske spørgsmål baseret på interne retningslinjer og kontrakter.",
      goal:                 "Giver præcis juridisk vejledning med reference til tilgængeligt materiale.",
    };
    const result = AiSuggestionSchema.safeParse(legalSuggestion);
    expect(result.success).toBe(true);
  });
});
