// Meridian Phase 9 — engagement scoring. Nightly job, not a webhook: pulls
// the day's PostHog events grouped by crm_person_id (Phase 8a's linkage,
// which *is* the Twenty Person id directly - no lookup needed), computes a
// weighted score per §weights in lib/engagementConfig.ts, writes it to
// Person.engagementScore, and fires a Twenty Task for Mark on threshold
// crossing.
//
// Score model: full stateless recompute over a fixed rolling window every
// run, not incremental. Deliberate - a rolling window needs to drop aging
// events, which an increment-from-yesterday model can't do without storing
// per-event history, and a full recompute is naturally idempotent (same
// window in, same score out), which is exactly what makes the "run the job
// twice, get exactly one task" requirement straightforward rather than
// requiring separate dedup bookkeeping.

import { engagementConfig, PER_INSTANCE_EVENT_TYPES } from '../lib/engagementConfig';
import { getPerInstanceCounts, getTopicConcentration } from '../lib/posthogClient';
import { createTask, findOpenEngagementTaskForPerson, getPersonById, linkTaskToPerson, PersonRecord, updatePerson } from '../lib/twentyClient';

type PersonScore = {
  crmPersonId: string;
  score: number;
  contributions: { event: string; count: number; weight: number; subtotal: number }[];
  concentrationUnits: number;
};

function computeScores(
  perInstanceRows: { crmPersonId: string; event: string; count: number }[],
  concentrationRows: { crmPersonId: string; topic: string; count: number }[]
): Map<string, PersonScore> {
  const scores = new Map<string, PersonScore>();

  const getOrInit = (pid: string): PersonScore => {
    let s = scores.get(pid);
    if (!s) {
      s = { crmPersonId: pid, score: 0, contributions: [], concentrationUnits: 0 };
      scores.set(pid, s);
    }
    return s;
  };

  for (const row of perInstanceRows) {
    if (!PER_INSTANCE_EVENT_TYPES.includes(row.event as (typeof PER_INSTANCE_EVENT_TYPES)[number])) continue;
    const weight = engagementConfig.weights[row.event as keyof typeof engagementConfig.weights] as number;
    const subtotal = row.count * weight;
    const s = getOrInit(row.crmPersonId);
    s.score += subtotal;
    s.contributions.push({ event: row.event, count: row.count, weight, subtotal });
  }

  // Concentration rewards sustained repeat-engagement with the same topic,
  // not the first couple of touches - only the count above
  // minTouchesPerTopic contributes, then each unit above that is weighted.
  const byPerson = new Map<string, typeof concentrationRows>();
  for (const row of concentrationRows) {
    const list = byPerson.get(row.crmPersonId) ?? [];
    list.push(row);
    byPerson.set(row.crmPersonId, list);
  }
  for (const [pid, topics] of byPerson) {
    const units = topics.reduce((sum, t) => sum + Math.max(0, t.count - engagementConfig.concentration.minTouchesPerTopic), 0);
    if (units === 0) continue;
    const s = getOrInit(pid);
    const subtotal = units * engagementConfig.weights.topicConcentration;
    s.score += subtotal;
    s.concentrationUnits = units;
    s.contributions.push({ event: 'topic_concentration', count: units, weight: engagementConfig.weights.topicConcentration, subtotal });
  }

  for (const s of scores.values()) {
    s.score = Math.round(s.score);
  }

  return scores;
}

async function maybeFireThresholdTask(
  personScore: PersonScore,
  previousScore: number | null,
  person: PersonRecord | null
): Promise<'fired' | 'skipped-not-crossed' | 'skipped-already-open'> {
  const { highThreshold, taskMarkerPrefix, markWorkspaceMemberId } = engagementConfig;
  const crossed = (previousScore == null || previousScore < highThreshold) && personScore.score >= highThreshold;
  if (!crossed) return 'skipped-not-crossed';

  // Secondary guard alongside the crossing check itself: protects against a
  // score that dips below threshold and re-crosses before Mark has closed
  // out the last task, which the crossing check alone wouldn't catch.
  const existing = await findOpenEngagementTaskForPerson(personScore.crmPersonId, taskMarkerPrefix);
  if (existing) return 'skipped-already-open';

  const label = person ? `${person.name.firstName} ${person.name.lastName}`.trim() || person.emails.primaryEmail : personScore.crmPersonId;

  const bodyLines = personScore.contributions.map((c) => `- ${c.event}: ${c.count} × ${c.weight} = ${c.subtotal}`);
  const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  const task = await createTask({
    title: `${taskMarkerPrefix} High signal — ${label} (score ${personScore.score})`,
    bodyMarkdown: `Engagement score crossed ${highThreshold} (now ${personScore.score}).\n\nContributing signals (last ${engagementConfig.lookbackDays} days):\n${bodyLines.join('\n')}`,
    assigneeId: markWorkspaceMemberId,
    dueAt,
  });
  await linkTaskToPerson(task.id, personScore.crmPersonId);
  return 'fired';
}

export type EngagementRollupResult = {
  personCount: number;
  scored: { crmPersonId: string; previousScore: number | null; newScore: number; taskOutcome: string }[];
  failed: { crmPersonId: string; error: string }[];
};

export async function rollupEngagement(): Promise<EngagementRollupResult> {
  const [perInstanceRows, concentrationRows] = await Promise.all([
    getPerInstanceCounts(PER_INSTANCE_EVENT_TYPES, engagementConfig.lookbackDays),
    getTopicConcentration(engagementConfig.lookbackDays),
  ]);

  const scores = computeScores(perInstanceRows, concentrationRows);

  const result: EngagementRollupResult = { personCount: scores.size, scored: [], failed: [] };

  for (const personScore of scores.values()) {
    try {
      const person = await getPersonById(personScore.crmPersonId);
      if (!person) {
        // Twenty's PATCH does not check deletedAt the way GET/filter does
        // (confirmed against the live instance) - it would silently
        // "succeed" against a soft-deleted Person, so this has to be an
        // explicit skip here rather than trusting updatePerson to fail
        // loudly on its own. A crm_person_id with no resolvable live
        // Person means Phase 8a's link has gone stale (deleted/merged CRM
        // record) - worth surfacing, not silently no-oping.
        result.failed.push({ crmPersonId: personScore.crmPersonId, error: 'no live Person found for this crm_person_id (deleted or never existed) - skipped' });
        continue;
      }
      const previousScore = (person.engagementScore as number | null | undefined) ?? null;

      const taskOutcome = await maybeFireThresholdTask(personScore, previousScore, person);

      // Write the new score AFTER reading the previous one and deciding on
      // the task - the crossing check needs yesterday's value, not today's.
      await updatePerson(personScore.crmPersonId, { engagementScore: personScore.score });

      result.scored.push({ crmPersonId: personScore.crmPersonId, previousScore, newScore: personScore.score, taskOutcome });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ crmPersonId: personScore.crmPersonId, error });
    }
  }

  return result;
}
