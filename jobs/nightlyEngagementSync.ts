// Cron entrypoint for Phase 9's engagement scoring, same convention as
// jobs/nightlyTaxonomySync.ts: a thin schedulable wrapper, called by both
// the nightly cron and the manual /sync/engagement trigger, so there's one
// code path to reason about. Logging is per-person and states which
// signals contributed and whether a task fired, so a run can be audited
// after the fact without reproducing it.

import { rollupEngagement } from '../connectors/posthog';

export async function runNightlyEngagementSync(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[engagement-sync] run started at ${startedAt}`);

  const { personCount, scored, failed } = await rollupEngagement();
  console.log(`[engagement-sync] ${personCount} people had qualifying events in the lookback window`);

  for (const s of scored) {
    const delta = s.previousScore == null ? `new (${s.newScore})` : `${s.previousScore} -> ${s.newScore}`;
    console.log(`[engagement-sync] ${s.crmPersonId}: score ${delta}, task: ${s.taskOutcome}`);
  }

  for (const f of failed) {
    console.error(`[engagement-sync]   failed: ${f.crmPersonId}: ${f.error}`);
  }

  const status = failed.length > 0 ? 'COMPLETED WITH ERRORS' : 'SUCCEEDED';
  console.log(`[engagement-sync] run ${status}, finished at ${new Date().toISOString()} (started ${startedAt})`);
}
