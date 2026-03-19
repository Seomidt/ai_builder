/**
 * Phase 50 — Analytics Foundation
 * Canonical Analytics Event Taxonomy
 *
 * Stable, explicit, versionable.
 * NO sensitive user content in event names.
 * Organised by family. Each event = family + "." + name.
 */

// ─── Families ─────────────────────────────────────────────────────────────────

export const ANALYTICS_FAMILIES = [
  "product",
  "funnel",
  "retention",
  "billing",
  "ai",
  "ops",
] as const;

export type AnalyticsFamily = (typeof ANALYTICS_FAMILIES)[number];

// ─── Canonical Event Names ────────────────────────────────────────────────────

export const ANALYTICS_EVENTS = {
  // product.*
  "product.signup_started":      "product",
  "product.signup_completed":    "product",
  "product.login":               "product",
  "product.logout":              "product",
  "product.program_created":     "product",
  "product.program_assigned":    "product",
  "product.checkin_submitted":   "product",
  "product.client_invited":      "product",
  "product.client_created":      "product",
  "product.dashboard_viewed":    "product",
  "product.profile_updated":     "product",
  "product.integration_added":   "product",
  "product.project_created":     "product",

  // funnel.*
  "funnel.landing_view":           "funnel",
  "funnel.pricing_view":           "funnel",
  "funnel.signup_view":            "funnel",
  "funnel.signup_completed":       "funnel",
  "funnel.trial_started":          "funnel",
  "funnel.subscription_started":   "funnel",
  "funnel.subscription_failed":    "funnel",
  "funnel.subscription_canceled":  "funnel",

  // retention.*
  "retention.session_started":          "retention",
  "retention.session_weekly_active":    "retention",
  "retention.checkin_completed":        "retention",
  "retention.program_interaction":      "retention",
  "retention.coach_client_message_sent": "retention",
  "retention.daily_active":             "retention",

  // billing.*
  "billing.checkout_started":    "billing",
  "billing.checkout_completed":  "billing",
  "billing.invoice_paid":        "billing",
  "billing.payment_failed":      "billing",
  "billing.plan_changed":        "billing",
  "billing.subscription_renewed": "billing",
  "billing.trial_expired":       "billing",

  // ai.*
  "ai.request_started":    "ai",
  "ai.request_completed":  "ai",
  "ai.request_failed":     "ai",
  "ai.limit_warning_shown": "ai",
  "ai.cache_hit":          "ai",
  "ai.budget_exceeded":    "ai",

  // ops.*
  "ops.dashboard_viewed":       "ops",
  "ops.alert_opened":           "ops",
  "ops.anomaly_viewed":         "ops",
  "ops.security_checklist_viewed": "ops",
  "ops.billing_audit_viewed":   "ops",
  "ops.tenant_management_viewed": "ops",
} as const satisfies Record<string, AnalyticsFamily>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

// ─── Lookup helpers ───────────────────────────────────────────────────────────

export function isValidEventName(name: string): name is AnalyticsEventName {
  return name in ANALYTICS_EVENTS;
}

export function getFamilyForEvent(name: AnalyticsEventName): AnalyticsFamily {
  return ANALYTICS_EVENTS[name];
}

export function getFamilyForEventUnsafe(name: string): AnalyticsFamily | null {
  if (!isValidEventName(name)) return null;
  return ANALYTICS_EVENTS[name];
}

export function getEventsByFamily(family: AnalyticsFamily): AnalyticsEventName[] {
  return (Object.keys(ANALYTICS_EVENTS) as AnalyticsEventName[]).filter(
    (k) => ANALYTICS_EVENTS[k] === family,
  );
}

export function isValidFamily(family: string): family is AnalyticsFamily {
  return (ANALYTICS_FAMILIES as readonly string[]).includes(family);
}

// ─── Source + domain role enums ───────────────────────────────────────────────

export const ANALYTICS_SOURCES    = ["client", "server", "system"] as const;
export const ANALYTICS_DOMAIN_ROLES = ["public", "app", "admin"] as const;

export type AnalyticsSource     = (typeof ANALYTICS_SOURCES)[number];
export type AnalyticsDomainRole = (typeof ANALYTICS_DOMAIN_ROLES)[number];

export function isValidSource(s: string): s is AnalyticsSource {
  return (ANALYTICS_SOURCES as readonly string[]).includes(s);
}

export function isValidDomainRole(r: string): r is AnalyticsDomainRole {
  return (ANALYTICS_DOMAIN_ROLES as readonly string[]).includes(r);
}

// ─── Supported locales ────────────────────────────────────────────────────────

export const SUPPORTED_LOCALES = ["en", "da"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function isValidLocale(l: string): l is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(l);
}
