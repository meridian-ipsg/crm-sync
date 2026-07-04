// Stage 3 connector (build when Stripe subscriptions go live, per Appendix D).
// Will handle Stripe's subscription.* and invoice.payment_failed webhooks,
// writing to the Subscription object only - Person.subscriberTier is a
// rollup off Subscription, not written here directly (§13 of the data model doc).

export type StripeWebhookPayload = {
  type: string;
  data: { object: Record<string, unknown> };
};

export async function handleStripeWebhook(_payload: StripeWebhookPayload): Promise<void> {
  throw new Error('stripe connector not implemented yet - Stripe is not live');
}
