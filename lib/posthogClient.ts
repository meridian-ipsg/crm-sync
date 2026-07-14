// Thin wrapper around PostHog's HogQL query API (Meridian Phase 9). No SDK
// dependency needed - posthog-node is a capture library, not a query one;
// the query endpoint is a plain authenticated POST, same fetch pattern as
// twentyClient.ts/logtoClient.ts.

const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
const POSTHOG_PERSONAL_API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;

if (!POSTHOG_PROJECT_ID || !POSTHOG_PERSONAL_API_KEY) {
  throw new Error('POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY environment variables are required');
}

async function queryHogQL(query: string): Promise<unknown[][]> {
  // refresh: force_blocking - PostHog caches query results by default (keyed
  // on query text), which would otherwise serve a stale result for the
  // nightly job's fixed query shape. Confirmed against the live project:
  // without this, a re-run within the cache window returned the same
  // (increasingly stale) numbers rather than reflecting new events.
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${POSTHOG_PERSONAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, refresh: 'force_blocking' }),
  });
  const json = (await res.json()) as { results?: unknown[][]; error?: string };
  if (!res.ok) {
    throw new Error(`PostHog HogQL query failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.results ?? [];
}

export type PerInstanceCountRow = { crmPersonId: string; event: string; count: number };
export type TopicConcentrationRow = { crmPersonId: string; topic: string; count: number };

// Per-instance counts of each weighted event type, grouped by crm_person_id.
// eventNames is the live set of PerInstanceEventType keys, passed in rather
// than imported directly so this file has no dependency on engagementConfig
// - keeps the query builder generic if the event list changes.
export async function getPerInstanceCounts(eventNames: string[], lookbackDays: number): Promise<PerInstanceCountRow[]> {
  const inList = eventNames.map((e) => `'${e}'`).join(', ');
  const rows = await queryHogQL(`
    SELECT properties.crm_person_id AS pid, event, count() AS c
    FROM events
    WHERE event IN (${inList})
      AND properties.crm_person_id != ''
      AND timestamp > now() - INTERVAL ${lookbackDays} DAY
    GROUP BY pid, event
  `);
  return rows.map(([pid, event, c]) => ({ crmPersonId: String(pid), event: String(event), count: Number(c) }));
}

// One row per (person, topic) they've touched, across all event types that
// carry topic_slugs - used for the "sustained topic concentration" signal.
export async function getTopicConcentration(lookbackDays: number): Promise<TopicConcentrationRow[]> {
  const rows = await queryHogQL(`
    SELECT properties.crm_person_id AS pid, arrayJoin(splitByChar(',', coalesce(properties.topic_slugs, ''))) AS topic, count() AS c
    FROM events
    WHERE properties.crm_person_id != ''
      AND properties.topic_slugs != ''
      AND timestamp > now() - INTERVAL ${lookbackDays} DAY
    GROUP BY pid, topic
  `);
  return rows.map(([pid, topic, c]) => ({ crmPersonId: String(pid), topic: String(topic), count: Number(c) }));
}
