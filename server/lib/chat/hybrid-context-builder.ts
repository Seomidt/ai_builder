/**
 * hybrid-context-builder.ts — Combine attachment + expert context for hybrid routing.
 *
 * For RULE B (hybrid) routes, the attachment is PRIMARY and expert knowledge is SECONDARY.
 * The combined prompt section makes it clear to the AI what comes from the document
 * vs. what comes from the expert's background knowledge.
 */

import type { DocumentContextItem } from "./route-decision.ts";

export interface HybridContext {
  /** Combined system prompt addition for hybrid mode */
  systemAddendum:     string;
  /** The document block to inject as a user message */
  documentBlock:      string;
  /** User-facing description of the context */
  contextDescription: string;
}

/**
 * Build the context for a hybrid route (attachment-first + expert secondary).
 *
 * The resulting context tells the AI:
 *  1. Use the uploaded document as the primary authoritative source
 *  2. The expert background knowledge may be used to fill gaps
 *  3. Never override document findings with general knowledge
 */
export function buildHybridContext(params: {
  documentContext: DocumentContextItem[];
  expertName:      string;
  expertCategory:  string | null;
}): HybridContext {
  const { documentContext, expertName, expertCategory } = params;

  const docBlock = documentContext
    .map((d) =>
      `FILNAVN: ${d.filename}\nTEGN: ${d.char_count}\n\n${d.extracted_text}`,
    )
    .join("\n\n---\n\n");

  const systemAddendum = [
    `Du er ${expertName}${expertCategory ? ` (${expertCategory})` : ""}.`,
    ``,
    `=== HYBRID KONTEKST — PRIORITETSREGLER ===`,
    `PRIORITET 1: Det uploadede dokument er den PRIMÆRE autoritative kilde.`,
    `PRIORITET 2: Din ekspertviden bruges KUN til at forklare eller uddybe — aldrig til at modsige dokumentet.`,
    `REGEL 1: Svar ALTID primært fra dokumentindholdet.`,
    `REGEL 2: Angiv tydeligt når du citerer fra dokumentet vs. uddyber med ekspertviden.`,
    `REGEL 3: Hvis svaret er i dokumentet, citer det direkte.`,
    `REGEL 4: Brug IKKE generel viden til at tilsidesætte dokumentets indhold.`,
    `REGEL 5: Svar på dansk.`,
    `=== SLUT REGLER ===`,
  ].join("\n");

  const contextDescription =
    `Bruger uploadet dokument (primær) + ${expertName} ekspertviden (sekundær)`;

  return { systemAddendum, documentBlock: docBlock, contextDescription };
}

/**
 * User-facing routing status messages (shown in the UI).
 */
export function getRoutingStatusMessage(routeType: string): string {
  switch (routeType) {
    case "attachment_first":
      return "Analyserer uploadet dokument";
    case "hybrid":
      return "Bruger uploadet dokument som primær kilde";
    case "expert_auto":
      return "Søger i intern videnbase";
    case "processing":
      return "Dokumentet behandles stadig — vent venligst";
    case "not_ready":
      return "Dokumentbehandling mislykkedes";
    case "no_context":
      return "Ingen tilgængelig kontekst";
    default:
      return "Forbereder svar";
  }
}
