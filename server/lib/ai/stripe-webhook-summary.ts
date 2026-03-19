export interface StripeWebhookEvent {
  id:            string;
  stripeEventId: string;
  eventType:     string;
  invoiceId?:    string;
  status:        string;
  createdAt:     Date;
}

export async function listStripeWebhookEvents(
  _limit = 50,
): Promise<StripeWebhookEvent[]> {
  return [];
}

export async function getStripeWebhookEventByStripeEventId(
  _stripeEventId: string,
): Promise<StripeWebhookEvent | null> {
  return null;
}

export async function getInvoiceStripeLifecycle(
  _invoiceId: string,
): Promise<StripeWebhookEvent[]> {
  return [];
}

export function explainStripeWebhookOutcome(event: StripeWebhookEvent): string {
  return `Stripe event ${event.eventType} (${event.stripeEventId}) — status: ${event.status}`;
}
