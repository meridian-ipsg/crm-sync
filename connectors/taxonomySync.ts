// Stage 2 connector (Meridian Stage 2 Phase 7, per Appendix D's phased
// pattern). Twenty is authoritative for Topic/Geography/Sector; this pulls
// all three into Payload's mirrored taxonomy collections. One-way only —
// Payload never writes back to Twenty for these three objects, and this
// connector never touches any other Twenty or Payload object.

import { getGeographies, getSectors, getTopics, TwentyTaxonomyRecord } from '../lib/twentyClient';
import {
  createTaxonomy,
  findTaxonomyByCrmId,
  findTaxonomyByName,
  findTaxonomyBySlug,
  TaxonomyCollection,
  updateTaxonomy,
} from '../lib/payloadClient';

// Matching order, locked in during Phase 7 after real data surfaced a real
// conflict: a literal "leave anything without a crm_id alone" reading
// breaks the moment Twenty's real taxonomy collides by slug or name with a
// record that predates this sync (Phase 1's manually-created test
// taxonomy, Phase 4/5's seed-migration taxonomy) — Payload's slug field is
// unique, so a naive create-if-no-crm_id-match crashes outright on those.
// Decision: adopt-and-backfill uniformly, regardless of whether the
// existing record originated in Phase 1 or Phase 5 — same row/id either
// way, so existing Content Item/Tender/Event relationships keep resolving.
//   1. crm_id match       -> already synced, update name/slug in place
//   2. slug match         -> adopt: backfill crm_id, sync name
//   3. exact name match   -> adopt: backfill crm_id, sync name, correct
//                             slug to Twenty's canonical value
//   4. none of the above  -> genuinely new, create
async function syncOne(
  collection: TaxonomyCollection,
  record: TwentyTaxonomyRecord
): Promise<'created' | 'adopted' | 'updated'> {
  const byCrmId = await findTaxonomyByCrmId(collection, record.id);
  if (byCrmId) {
    await updateTaxonomy(collection, byCrmId.id, { name: record.name, slug: record.slug });
    return 'updated';
  }

  const bySlug = await findTaxonomyBySlug(collection, record.slug);
  if (bySlug) {
    await updateTaxonomy(collection, bySlug.id, { name: record.name, crm_id: record.id });
    return 'adopted';
  }

  const byName = await findTaxonomyByName(collection, record.name);
  if (byName) {
    await updateTaxonomy(collection, byName.id, { name: record.name, slug: record.slug, crm_id: record.id });
    return 'adopted';
  }

  await createTaxonomy(collection, { name: record.name, slug: record.slug, crm_id: record.id });
  return 'created';
}

export type TaxonomySyncResult = {
  collection: TaxonomyCollection;
  created: number;
  adopted: number;
  updated: number;
  failed: { name: string; crmId: string; error: string }[];
};

async function syncCollection(
  collection: TaxonomyCollection,
  records: TwentyTaxonomyRecord[]
): Promise<TaxonomySyncResult> {
  const result: TaxonomySyncResult = { collection, created: 0, adopted: 0, updated: 0, failed: [] };

  for (const record of records) {
    try {
      const outcome = await syncOne(collection, record);
      result[outcome]++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`taxonomy sync: failed to sync ${collection} record "${record.name}" (${record.id})`, error);
      result.failed.push({ name: record.name, crmId: record.id, error });
    }
  }

  return result;
}

export type TaxonomySyncOutcome = {
  results: TaxonomySyncResult[];
  // Stale-on-error (technical notes item 4): each collection's Twenty fetch
  // is isolated from the others, so a failure fetching e.g. Sectors doesn't
  // block Topics/Geographies, and never wipes or blanks Payload's existing
  // data — a failed fetch just skips that collection for this run, leaving
  // whatever Payload already has serving as-is.
  fetchErrors: { collection: TaxonomyCollection; error: string }[];
};

export async function syncTaxonomy(): Promise<TaxonomySyncOutcome> {
  const jobs: { collection: TaxonomyCollection; fetch: () => Promise<TwentyTaxonomyRecord[]> }[] = [
    { collection: 'topics', fetch: getTopics },
    { collection: 'geographies', fetch: getGeographies },
    { collection: 'sectors', fetch: getSectors },
  ];

  const results: TaxonomySyncResult[] = [];
  const fetchErrors: { collection: TaxonomyCollection; error: string }[] = [];

  for (const job of jobs) {
    try {
      const records = await job.fetch();
      results.push(await syncCollection(job.collection, records));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(
        `taxonomy sync: failed to fetch ${job.collection} from Twenty — leaving Payload's existing ${job.collection} untouched`,
        error
      );
      fetchErrors.push({ collection: job.collection, error });
    }
  }

  return { results, fetchErrors };
}
