// Stage 3/4 connector (build when PostHog instrumentation exists, per Appendix D).
// Nightly job, not a webhook - rolls up dashboardSessionsLast30Days and
// lastDashboardActiveAt onto Person (§3 of the data model doc), and feeds
// into the engagementScore computation (§12). Called from
// jobs/nightlyRollup.ts once that job exists.

export async function rollupPostHogUsage(): Promise<void> {
  throw new Error('posthog connector not implemented yet - PostHog instrumentation does not exist');
}
