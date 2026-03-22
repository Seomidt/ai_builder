export async function handleStripeWebhook(
  _rawBody: Buffer,
  _sig:     string,
): Promise<{ outcome: string; reason: string }> {
  return { outcome: "skipped", reason: "STRIPE_NOT_CONFIGURED" };
}
