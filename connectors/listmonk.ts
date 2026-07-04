// Stage 4 connector (build when Listmonk is deployed, per Appendix D).
// Nightly job, not a webhook - rolls up email_open_rate_last_30_days,
// email_click_rate_last_30_days and last_email_engagement_at onto Person
// (§3 of the data model doc). Called from jobs/nightlyRollup.ts once that
// job exists.

export async function rollupListmonkEngagement(): Promise<void> {
  throw new Error('listmonk connector not implemented yet - Listmonk is not deployed');
}
