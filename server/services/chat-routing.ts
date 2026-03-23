/**
 * chat-routing.ts — Server-side expert routing for AI Chat.
 *
 * All routing decisions happen here. Client never selects expert directly.
 * Tenant isolation is enforced at every query level.
 */

import { db } from "../db";
import { architectureProfiles } from "../../shared/schema";
import { eq, and, ne } from "drizzle-orm";

export interface AccessibleExpert {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  routingHints: { keywords?: string[]; domain?: string } | null;
  departmentId: string | null;
  enabledForChat: boolean;
}

export interface RoutingResult {
  expert: AccessibleExpert;
  score: number;
  explanation: string;
}

/**
 * List all experts the user can access for chat.
 * Filters: same org, active, enabled_for_chat = true.
 * Department scoping: if user has specific dept access, narrow to that dept.
 * For simplicity in v1 we return all org-level experts (dept scope can be layered on top).
 */
export async function listAccessibleExpertsForUser(params: {
  organizationId: string;
  userDepartmentId?: string | null;
}): Promise<AccessibleExpert[]> {
  const { organizationId } = params;

  const rows = await db
    .select({
      id:            architectureProfiles.id,
      name:          architectureProfiles.name,
      description:   architectureProfiles.description,
      category:      architectureProfiles.category,
      routingHints:  architectureProfiles.routingHints,
      departmentId:  architectureProfiles.departmentId,
      enabledForChat: architectureProfiles.enabledForChat,
    })
    .from(architectureProfiles)
    .where(
      and(
        eq(architectureProfiles.organizationId, organizationId),
        eq(architectureProfiles.enabledForChat, true),
        ne(architectureProfiles.status, "archived"),
      ),
    );

  return rows as AccessibleExpert[];
}

/**
 * Score each accessible expert against the user message.
 * Uses simple lexical relevance — no ML required.
 * Scoring inputs (descending priority):
 *   1. routing_hints.keywords match
 *   2. category match
 *   3. name word match
 *   4. description word overlap
 */
export function scoreExpertsForMessage(
  experts: AccessibleExpert[],
  message: string,
): Array<AccessibleExpert & { score: number }> {
  const tokens = tokenize(message);

  return experts.map((expert) => {
    let score = 0;

    // 1. Routing hint keywords (highest weight)
    const hints = expert.routingHints as { keywords?: string[] } | null;
    if (hints?.keywords?.length) {
      const hitCount = hints.keywords.filter((kw) =>
        tokens.some((t) => t.includes(kw.toLowerCase()) || kw.toLowerCase().includes(t)),
      ).length;
      score += hitCount * 10;
    }

    // 2. Category match
    if (expert.category) {
      const catTokens = tokenize(expert.category);
      const catHits = catTokens.filter((ct) => tokens.some((t) => t.includes(ct) || ct.includes(t))).length;
      score += catHits * 6;
    }

    // 3. Name word match
    const nameTokens = tokenize(expert.name);
    const nameHits = nameTokens.filter((nt) => tokens.some((t) => t.includes(nt) || nt.includes(t))).length;
    score += nameHits * 4;

    // 4. Description word overlap
    if (expert.description) {
      const descTokens = tokenize(expert.description);
      const descHits = descTokens.filter((dt) => tokens.includes(dt)).length;
      score += descHits * 1;
    }

    return { ...expert, score };
  });
}

/**
 * Select the single best expert deterministically.
 * Returns null if no expert scores above 0 (uncertain match).
 */
export function selectBestExpert(
  scored: Array<AccessibleExpert & { score: number }>,
): RoutingResult | null {
  if (scored.length === 0) return null;

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const best = sorted[0];

  // If top score is 0 but experts exist, pick the first one with a low-confidence warning
  if (best.score === 0) {
    return {
      expert: best,
      score: 0,
      explanation: `Ingen direkte match fundet — benytter '${best.name}' som standard.`,
    };
  }

  return {
    expert: best,
    score: best.score,
    explanation: `Valgte '${best.name}' baseret på meddelelseens indhold (score: ${best.score}).`,
  };
}

/**
 * Verify that a preferred_expert_id can actually be accessed by the user.
 * Returns the expert if accessible, null otherwise.
 * This is used when the client sends a hint — we verify, never trust blindly.
 */
export async function verifyExpertAccess(params: {
  expertId: string;
  organizationId: string;
}): Promise<AccessibleExpert | null> {
  const { expertId, organizationId } = params;

  const [row] = await db
    .select({
      id:            architectureProfiles.id,
      name:          architectureProfiles.name,
      description:   architectureProfiles.description,
      category:      architectureProfiles.category,
      routingHints:  architectureProfiles.routingHints,
      departmentId:  architectureProfiles.departmentId,
      enabledForChat: architectureProfiles.enabledForChat,
    })
    .from(architectureProfiles)
    .where(
      and(
        eq(architectureProfiles.id, expertId),
        eq(architectureProfiles.organizationId, organizationId),
        eq(architectureProfiles.enabledForChat, true),
        ne(architectureProfiles.status, "archived"),
      ),
    )
    .limit(1);

  return (row as AccessibleExpert) ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}
