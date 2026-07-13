// Cron entrypoint for the Phase 7 taxonomy sync (Appendix D's jobs/
// convention: a thin, schedulable wrapper around a connector's actual
// logic). Called by the in-process nightly scheduler in index.ts and by
// the manual /sync/taxonomy trigger endpoint — both go through this same
// function, so there's exactly one code path to reason about, not two.
//
// Logging is deliberately verbose per-collection: the goal is that anyone
// reading logs after the fact can tell whether a given run succeeded,
// partially failed, or was skipped, without needing to reproduce it.

import { syncTaxonomy } from '../connectors/taxonomySync';

export async function runNightlyTaxonomySync(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`[taxonomy-sync] run started at ${startedAt}`);

  const { results, fetchErrors } = await syncTaxonomy();

  for (const result of results) {
    console.log(
      `[taxonomy-sync] ${result.collection}: created=${result.created} adopted=${result.adopted} updated=${result.updated} failed=${result.failed.length}`
    );
    for (const failure of result.failed) {
      console.error(
        `[taxonomy-sync]   failed: ${result.collection} "${failure.name}" (${failure.crmId}): ${failure.error}`
      );
    }
  }

  for (const fetchError of fetchErrors) {
    console.error(
      `[taxonomy-sync] skipped ${fetchError.collection} entirely — Twenty fetch failed, Payload's existing ${fetchError.collection} left untouched: ${fetchError.error}`
    );
  }

  const totalFailed = results.reduce((sum, r) => sum + r.failed.length, 0);
  const status = fetchErrors.length > 0 || totalFailed > 0 ? 'COMPLETED WITH ERRORS' : 'SUCCEEDED';
  console.log(`[taxonomy-sync] run ${status}, finished at ${new Date().toISOString()} (started ${startedAt})`);
}
