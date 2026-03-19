/**
 * Phase 50 — Analytics Foundation
 * Client-side Analytics Wrapper
 *
 * Central client-side tracking — no raw window-level event spam.
 * Validates against shared taxonomy before sending.
 * Sends only approved payload fields.
 * Authenticated requests include user/org context from server (not client-provided).
 */

import {
  isValidEventName,
  isValidDomainRole,
  isValidLocale,
  type AnalyticsEventName,
  type AnalyticsDomainRole,
  type SupportedLocale,
} from "../../../../server/lib/analytics/event-taxonomy";

const ANALYTICS_ENDPOINT = "/api/analytics/track";

export interface ClientTrackPayload {
  eventName:   AnalyticsEventName;
  domainRole?: AnalyticsDomainRole;
  locale?:     SupportedLocale;
  sessionId?:  string;
  properties?: Record<string, unknown>;
}

// ─── Allowed client-provided property keys ────────────────────────────────────

const ALLOWED_CLIENT_PROPS = new Set([
  "plan_tier",
  "feature",
  "route",
  "page",
  "locale",
  "domain_role",
  "duration_ms",
  "count",
  "status",
  "flag",
  "reason",
  "variant",
  "referrer",
  "device_type",
]);

function sanitizeClientProps(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_CLIENT_PROPS.has(key)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      result[key] = value;
    }
  }
  return result;
}

// ─── Core client track function ───────────────────────────────────────────────

export async function track(payload: ClientTrackPayload): Promise<void> {
  if (!isValidEventName(payload.eventName)) {
    if (import.meta.env.DEV) {
      console.warn(`[analytics] Unknown event: ${payload.eventName} — dropped`);
    }
    return;
  }

  if (payload.domainRole && !isValidDomainRole(payload.domainRole)) {
    if (import.meta.env.DEV) {
      console.warn(`[analytics] Invalid domainRole: ${payload.domainRole} — dropped`);
    }
    return;
  }

  if (payload.locale && !isValidLocale(payload.locale)) {
    if (import.meta.env.DEV) {
      console.warn(`[analytics] Invalid locale: ${payload.locale} — dropped`);
    }
    return;
  }

  const sanitizedProps = sanitizeClientProps(payload.properties ?? {});

  const body = {
    eventName:  payload.eventName,
    domainRole: payload.domainRole ?? null,
    locale:     payload.locale     ?? null,
    sessionId:  payload.sessionId  ?? null,
    properties: sanitizedProps,
  };

  try {
    await fetch(ANALYTICS_ENDPOINT, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      keepalive: true,
    });
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error("[analytics] Failed to send event:", err);
    }
  }
}

// ─── Convenience family wrappers ──────────────────────────────────────────────

type ProductEventName   = Extract<AnalyticsEventName, `product.${string}`>;
type FunnelEventName    = Extract<AnalyticsEventName, `funnel.${string}`>;
type RetentionEventName = Extract<AnalyticsEventName, `retention.${string}`>;
type BillingEventName   = Extract<AnalyticsEventName, `billing.${string}`>;
type AiEventName        = Extract<AnalyticsEventName, `ai.${string}`>;
type OpsEventName       = Extract<AnalyticsEventName, `ops.${string}`>;

type BaseClientPayload = Omit<ClientTrackPayload, "eventName">;

export const trackProduct   = (name: ProductEventName,   p?: BaseClientPayload) => track({ eventName: name, domainRole: "app",    ...p });
export const trackFunnel    = (name: FunnelEventName,    p?: BaseClientPayload) => track({ eventName: name, domainRole: "public", ...p });
export const trackRetention = (name: RetentionEventName, p?: BaseClientPayload) => track({ eventName: name, domainRole: "app",    ...p });
export const trackBilling   = (name: BillingEventName,   p?: BaseClientPayload) => track({ eventName: name, domainRole: "app",    ...p });
export const trackAi        = (name: AiEventName,        p?: BaseClientPayload) => track({ eventName: name, domainRole: "app",    ...p });
export const trackOps       = (name: OpsEventName,       p?: BaseClientPayload) => track({ eventName: name, domainRole: "admin",  ...p });
