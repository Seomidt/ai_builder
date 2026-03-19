export interface StripeCheckoutSession {
  sessionId:  string;
  url:        string;
  status:     "open" | "complete" | "expired";
  invoiceId:  string;
}

export async function createStripeCheckoutForInvoice(
  _invoiceId: string,
  _orgId: string,
): Promise<StripeCheckoutSession> {
  throw new Error("Stripe not configured — set STRIPE_SECRET_KEY to enable");
}

export async function createStripePaymentIntentForInvoice(
  _invoiceId: string,
  _orgId: string,
): Promise<{ clientSecret: string; paymentIntentId: string }> {
  throw new Error("Stripe not configured — set STRIPE_SECRET_KEY to enable");
}

export async function getStripeCheckoutState(
  _sessionId: string,
): Promise<StripeCheckoutSession | null> {
  return null;
}
