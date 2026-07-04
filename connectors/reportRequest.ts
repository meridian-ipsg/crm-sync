// Stage 3 connector (build when the Payload report request flow exists, per Appendix D).
// Will handle the webhook fired on Report Request submission from the
// Meridian portal (Payload) and create the corresponding Report Request
// record in Twenty (§13 of the data model doc).

export type ReportRequestWebhookPayload = {
  personLogtoUserId: string;
  productId: string;
  [key: string]: unknown;
};

export async function handleReportRequestWebhook(_payload: ReportRequestWebhookPayload): Promise<void> {
  throw new Error('report request connector not implemented yet - Payload report request flow does not exist');
}
