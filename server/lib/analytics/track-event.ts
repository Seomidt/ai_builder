/**
 * Phase 50 — Analytics Foundation
 * Server-side Analytics Event Tracking
 *
 * Never blocks the request path on failure.
 * Validates against canonical taxonomy.
 * Sanitizes payload per privacy rules.
 */

import { db } from "../../db";
import { analyticsEvents } from "../../../shared/schema";
import {
  isValidEventName,
  getFamilyForEvent,
  isValidSource,
  isValidDomainRole,
  isValidLocale,
  type AnalyticsEventName,
  type AnalyticsSource,
  type AnalyticsDomainRole,
  type SupportedLocale,
} from "./event-taxonomy";
import { sanitizeAnalyticsPayload } from "./privacy-rules";

// ─── Core input type ──────────────────────────────────────────────────────────

export interface TrackEventInput {
  eventName:      AnalyticsEventName;
  source:         AnalyticsSource;
  organizationId?: string | null;
  actorUserId?:   string | null;
  clientId?:      string | null;
  domainRole?:    AnalyticsDomainRole | null;
  locale?:        SupportedLocale | null;
  sessionId?:     string | null;
  requestId?:     string | null;
  properties?:    Record<string, unknown>;
}

// ─── Core tracking function ───────────────────────────────────────────────────

export async function trackAnalyticsEvent(input: TrackEventInput): Promise<void> {
  try {
    if (!isValidEventName(input.eventName)) {
      console.warn(`[analytics] Unknown event name: ${input.eventName} — dropped`);
      return;
    }
    if (!isValidSource(input.source)) {
      console.warn(`[analytics] Invalid source: ${input.source} — dropped`);
      return;
    }
    if (input.domainRole && !isValidDomainRole(input.domainRole)) {
      console.warn(`[analytics] Invalid domainRole: ${input.domainRole} — dropped`);
      return;
    }
    if (input.locale && !isValidLocale(input.locale)) {
      console.warn(`[analytics] Invalid locale: ${input.locale} — dropped`);
      return;
    }

    const family     = getFamilyForEvent(input.eventName);
    const properties = sanitizeAnalyticsPayload(input.properties ?? {});

    await db.insert(analyticsEvents).values({
      organizationId: input.organizationId ?? null,
      actorUserId:    input.actorUserId    ?? null,
      clientId:       input.clientId       ?? null,
      eventName:      input.eventName,
      eventFamily:    family,
      source:         input.source,
      domainRole:     input.domainRole     ?? null,
      locale:         input.locale         ?? null,
      sessionId:      input.sessionId      ?? null,
      requestId:      input.requestId      ?? null,
      properties,
    });
  } catch (err) {
    console.error("[analytics] Failed to write event:", err);
  }
}

// ─── Family-scoped convenience wrappers ───────────────────────────────────────

type ProductEventName   = Extract<AnalyticsEventName, `product.${string}`>;
type FunnelEventName    = Extract<AnalyticsEventName, `funnel.${string}`>;
type RetentionEventName = Extract<AnalyticsEventName, `retention.${string}`>;
type BillingEventName   = Extract<AnalyticsEventName, `billing.${string}`>;
type AiEventName        = Extract<AnalyticsEventName, `ai.${string}`>;
type OpsEventName       = Extract<AnalyticsEventName, `ops.${string}`>;

type BaseInput = Omit<TrackEventInput, "eventName" | "source">;

export async function trackProductEvent(
  eventName: ProductEventName,
  input: BaseInput,
): Promise<void> {
  return trackAnalyticsEvent({ ...input, eventName, source: "server" });
}

export async function trackFunnelEvent(
  eventName: FunnelEventName,
  input: BaseInput,
): Promise<void> {
  return trackAnalyticsEvent({ ...input, eventName, source: "server" });
}

export async function trackRetentionEvent(
  eventName: RetentionEventName,
  input: BaseInput,
): Promise<void> {
  return trackAnalyticsEvent({ ...input, eventName, source: "server" });
}

export async function trackBillingEvent(
  eventName: BillingEventName,
  input: BaseInput,
): Promise<void> {
  return trackAnalyticsEvent({ ...input, eventName, source: "server" });
}

export async function trackAiEvent(
  eventName: AiEventName,
  input: BaseInput,
): Promise<void> {
  return trackAnalyticsEvent({ ...input, eventName, source: "server" });
}

export async function trackOpsEvent(
  eventName: OpsEventName,
  input: BaseInput,
): Promise<void> {
  return trackAnalyticsEvent({ ...input, eventName, source: "server" });
}
