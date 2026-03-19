import { Request, Response } from "express";

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  res.status(400).json({ error_code: "STRIPE_NOT_CONFIGURED", message: "Stripe webhooks not configured" });
}
