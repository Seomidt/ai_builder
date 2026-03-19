/**
 * SEO / Robots / Indexing Rules
 * Phase 49 — Domain/Subdomain Architecture
 */

import { DomainRole, DOMAIN_ROLE, getDomainRoleFromHost } from "./config";

// ─── Indexing Rules by Role ───────────────────────────────────────────────────

export interface SeoRule {
  indexed:           boolean;
  robotsDirective:   string;
  sitemapEligible:   boolean;
  canonicalRequired: boolean;
  hreflangRequired:  boolean;
  notes:             string;
}

export const SEO_RULES: Record<DomainRole, SeoRule> = {
  [DOMAIN_ROLE.PUBLIC]: {
    indexed:           true,
    robotsDirective:   "index, follow",
    sitemapEligible:   true,
    canonicalRequired: true,
    hreflangRequired:  true,
    notes:             "Full SEO. Locale-canonical tags required. sitemap.xml at /sitemap.xml.",
  },
  [DOMAIN_ROLE.APP]: {
    indexed:           false,
    robotsDirective:   "noindex, nofollow",
    sitemapEligible:   false,
    canonicalRequired: false,
    hreflangRequired:  false,
    notes:             "Authenticated SPA. Must not appear in search engines. No sitemap.",
  },
  [DOMAIN_ROLE.ADMIN]: {
    indexed:           false,
    robotsDirective:   "noindex, nofollow, noarchive",
    sitemapEligible:   false,
    canonicalRequired: false,
    hreflangRequired:  false,
    notes:             "Internal ops console. robots.txt must fully disallow. No public exposure.",
  },
  [DOMAIN_ROLE.AUTH]: {
    indexed:           false,
    robotsDirective:   "noindex, nofollow",
    sitemapEligible:   false,
    canonicalRequired: false,
    hreflangRequired:  false,
    notes:             "Auth callback paths. Must not be indexed. Shares rules with app domain.",
  },
};

// ─── Robots.txt Content by Role ───────────────────────────────────────────────

export const ROBOTS_TXT: Record<DomainRole, string> = {
  [DOMAIN_ROLE.PUBLIC]: `User-agent: *
Allow: /

Sitemap: https://blissops.com/sitemap.xml
`,
  [DOMAIN_ROLE.APP]: `User-agent: *
Disallow: /
`,
  [DOMAIN_ROLE.ADMIN]: `User-agent: *
Disallow: /
`,
  [DOMAIN_ROLE.AUTH]: `User-agent: *
Disallow: /
`,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true if the domain/role should be indexed */
export function shouldIndexDomain(role: DomainRole): boolean {
  return SEO_RULES[role].indexed;
}

/** Returns the robots meta / X-Robots-Tag directive for a role */
export function getRobotsPolicyForDomain(role: DomainRole): string {
  return SEO_RULES[role].robotsDirective;
}

/** Returns true if sitemap.xml should be generated for this role */
export function getSitemapEligibility(role: DomainRole): boolean {
  return SEO_RULES[role].sitemapEligible;
}

/** Returns true if canonical tags are required for this role */
export function requiresCanonicalTag(role: DomainRole): boolean {
  return SEO_RULES[role].canonicalRequired;
}

/** Returns true if hreflang link tags are required for this role */
export function requiresHreflang(role: DomainRole): boolean {
  return SEO_RULES[role].hreflangRequired;
}

/** Resolve SEO rule from a hostname string */
export function getSeoRuleForHost(hostname: string): SeoRule {
  const role = getDomainRoleFromHost(hostname);
  if (role === null) {
    // Unknown host — treat as fully restricted
    return {
      indexed:           false,
      robotsDirective:   "noindex, nofollow, noarchive",
      sitemapEligible:   false,
      canonicalRequired: false,
      hreflangRequired:  false,
      notes:             "Unknown host — default to noindex for safety.",
    };
  }
  return SEO_RULES[role];
}

/** Returns the robots.txt body for a given domain role */
export function getRobotsTxtBody(role: DomainRole): string {
  return ROBOTS_TXT[role];
}
