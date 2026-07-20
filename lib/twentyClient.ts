// Thin wrapper around Twenty's REST API. Every connector goes through this
// rather than calling fetch() directly, so auth and error handling live in
// one place. See Appendix D of the CRM data model doc.

const BASE_URL = process.env.TWENTY_BASE_URL || 'https://crm.ipsg.com.au';
const TOKEN = process.env.TWENTY_API_TOKEN;

if (!TOKEN) {
  throw new Error('TWENTY_API_TOKEN environment variable is required');
}

export class TwentyRequestError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE_URL + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const json = (await res.json()) as { data: T };
  if (!res.ok) {
    throw new TwentyRequestError(`${init.method || 'GET'} ${path} failed (${res.status}): ${JSON.stringify(json)}`, res.status);
  }
  return json.data;
}

export type PersonRecord = {
  id: string;
  logtoUserId: string | null;
  name: { firstName: string; lastName: string };
  emails: { primaryEmail: string; additionalEmails: string[] };
  [key: string]: unknown;
};

// Twenty's REST filter syntax: filter=fieldName[eq]:"value"
// https://crm.ipsg.com.au/rest/people?filter=logtoUserId[eq]:"..."
export async function findPersonByLogtoUserId(logtoUserId: string): Promise<PersonRecord | null> {
  const encoded = encodeURIComponent(`logtoUserId[eq]:"${logtoUserId}"`);
  const data = await request<{ people: PersonRecord[] }>(`/rest/people?filter=${encoded}&limit=1`);
  return data.people[0] ?? null;
}

// Composite fields filter on their sub-path (confirmed against the live
// instance): emails.primaryEmail[eq]:"...".
export async function findPersonByEmail(email: string): Promise<PersonRecord | null> {
  const encoded = encodeURIComponent(`emails.primaryEmail[eq]:"${email}"`);
  const data = await request<{ people: PersonRecord[] }>(`/rest/people?filter=${encoded}&limit=1`);
  return data.people[0] ?? null;
}

export async function createPerson(fields: Record<string, unknown>): Promise<PersonRecord> {
  const data = await request<{ createPerson: PersonRecord }>('/rest/people', {
    method: 'POST',
    body: JSON.stringify(fields),
  });
  return data.createPerson;
}

export async function updatePerson(id: string, fields: Record<string, unknown>): Promise<PersonRecord> {
  const data = await request<{ updatePerson: PersonRecord }>(`/rest/people/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  return data.updatePerson;
}

// Upsert keyed on logtoUserId, the sync key set at signup (§3 of the data model doc).
// Used by connectors/logto.ts for User.Data.Updated events, where the Person
// this user maps to has necessarily already been created/adopted by a prior
// signup event.
export async function upsertPersonByLogtoUserId(
  logtoUserId: string,
  fields: Record<string, unknown>
): Promise<PersonRecord> {
  const existing = await findPersonByLogtoUserId(logtoUserId);
  if (existing) {
    return updatePerson(existing.id, fields);
  }
  return createPerson({ ...fields, logtoUserId });
}

export type SignupSyncOutcome = 'created' | 'adopted' | 'updated';

// Signup-time upsert (Meridian Phase 8a). Twenty and IPSG share one CRM
// instance, so a Meridian signup's email colliding with an existing
// consulting-relationship Person is a realistic first-user scenario, not an
// edge case - matched and adopted here rather than left to create a
// duplicate, same adopt-and-backfill principle Phase 7 applied to taxonomy.
//   1. logtoUserId match  -> already synced (e.g. a retried/duplicate
//                            delivery of the same signup event), update in place
//   2. email match        -> adopt: link this signup to the existing Person
//                            rather than duplicating it
//   3. neither            -> genuinely new, create
export async function upsertPersonForSignup(
  logtoUserId: string,
  email: string | null,
  fields: Record<string, unknown>
): Promise<{ person: PersonRecord; outcome: SignupSyncOutcome }> {
  const byLogtoUserId = await findPersonByLogtoUserId(logtoUserId);
  if (byLogtoUserId) {
    return { person: await updatePerson(byLogtoUserId.id, fields), outcome: 'updated' };
  }

  if (email) {
    const byEmail = await findPersonByEmail(email);
    if (byEmail) {
      return { person: await updatePerson(byEmail.id, { ...fields, logtoUserId }), outcome: 'adopted' };
    }
  }

  return { person: await createPerson({ ...fields, logtoUserId }), outcome: 'created' };
}

// Stage 2 (Meridian Phase 7) — Topic/Geography/Sector taxonomy, read-only
// from crm-sync's side (Twenty is authoritative, this service never writes
// these back). All three are small, fixed-size custom objects (~20/8/7
// records at the time of writing per Mark's research brief) - a single
// generously-limited request covers the whole collection, confirmed
// against the real data (limit=100 returns hasNextPage: false for all
// three), so this deliberately doesn't implement cursor pagination.
export type TwentyTaxonomyRecord = {
  id: string;
  name: string;
  slug: string;
};

async function getAllTaxonomy<K extends string>(path: string, dataKey: K): Promise<TwentyTaxonomyRecord[]> {
  const data = await request<Record<K, TwentyTaxonomyRecord[]>>(`${path}?limit=200`);
  return data[dataKey];
}

export async function getTopics(): Promise<TwentyTaxonomyRecord[]> {
  return getAllTaxonomy('/rest/topics', 'topics');
}

export async function getGeographies(): Promise<TwentyTaxonomyRecord[]> {
  return getAllTaxonomy('/rest/geographies', 'geographies');
}

export async function getSectors(): Promise<TwentyTaxonomyRecord[]> {
  return getAllTaxonomy('/rest/sectors', 'sectors');
}

// Meridian Phase 9 — engagement scoring and task creation.

export async function getPersonById(id: string): Promise<PersonRecord | null> {
  try {
    const data = await request<{ person: PersonRecord }>(`/rest/people/${id}`);
    return data.person;
  } catch (err) {
    if (err instanceof TwentyRequestError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export type TwentyTask = {
  id: string;
  title: string;
  status: 'TODO' | 'IN_PROGRESS' | 'DONE';
  dueAt: string | null;
  assigneeId: string | null;
};

// bodyV2 write shape confirmed against the live instance: passing
// { markdown, blocknote: null } is enough, Twenty derives the blocknote
// JSON itself - no need to hand-construct it.
export async function createTask(fields: {
  title: string;
  bodyMarkdown?: string;
  assigneeId: string;
  dueAt?: string;
  status?: 'TODO' | 'IN_PROGRESS' | 'DONE';
}): Promise<TwentyTask> {
  const data = await request<{ createTask: TwentyTask }>('/rest/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: fields.title,
      assigneeId: fields.assigneeId,
      status: fields.status ?? 'TODO',
      dueAt: fields.dueAt,
      ...(fields.bodyMarkdown ? { bodyV2: { markdown: fields.bodyMarkdown, blocknote: null } } : {}),
    }),
  });
  return data.createTask;
}

// Task<->Person linkage goes through the taskTarget junction object -
// Twenty has no MANY_TO_MANY relations in this version, this is its own
// standard pattern for it (confirmed against the live instance).
export async function linkTaskToPerson(taskId: string, personId: string): Promise<void> {
  await request('/rest/taskTargets', {
    method: 'POST',
    body: JSON.stringify({ taskId, personId }),
  });
}

// Meridian Phase 14 — topic/geography email preferences and subscriber tier.
//
// topicPreference/geographyPreference are pre-existing junction objects
// (created 2026-07-03, alongside Topic/Geography themselves - predates this
// phase, confirmed via /rest/metadata/objects, not something this phase adds
// via the Metadata API). Twenty has no MANY_TO_MANY relations in this
// version, so a Person's preferred topics/geographies are modelled as one
// junction row per (person, topic) / (person, geography) pair, same pattern
// taskTarget already uses for Task<->Person.
//
// The ids this connector receives (topic_crm_ids/geography_crm_ids off
// Logto custom data) are already Twenty's own topic/geography record ids -
// the website resolves Payload's crm_id field to get them, so no
// slug/name lookup happens here.

export type TopicPreferenceRecord = { id: string; topicId: string };
export type GeographyPreferenceRecord = { id: string; geographyId: string };

export async function getPersonTopicPreferences(personId: string): Promise<TopicPreferenceRecord[]> {
  const encoded = encodeURIComponent(`personId[eq]:"${personId}"`);
  const data = await request<{ topicPreferences: { id: string; topicId: string }[] }>(
    `/rest/topicPreferences?filter=${encoded}&limit=100`
  );
  return data.topicPreferences.map((r) => ({ id: r.id, topicId: r.topicId }));
}

export async function getPersonGeographyPreferences(personId: string): Promise<GeographyPreferenceRecord[]> {
  const encoded = encodeURIComponent(`personId[eq]:"${personId}"`);
  const data = await request<{ geographyPreferences: { id: string; geographyId: string }[] }>(
    `/rest/geographyPreferences?filter=${encoded}&limit=100`
  );
  return data.geographyPreferences.map((r) => ({ id: r.id, geographyId: r.geographyId }));
}

async function createTopicPreference(personId: string, topicId: string): Promise<void> {
  await request('/rest/topicPreferences', {
    method: 'POST',
    body: JSON.stringify({ personId, topicId }),
  });
}

async function createGeographyPreference(personId: string, geographyId: string): Promise<void> {
  await request('/rest/geographyPreferences', {
    method: 'POST',
    body: JSON.stringify({ personId, geographyId }),
  });
}

async function deleteTopicPreference(id: string): Promise<void> {
  await request(`/rest/topicPreferences/${id}`, { method: 'DELETE' });
}

async function deleteGeographyPreference(id: string): Promise<void> {
  await request(`/rest/geographyPreferences/${id}`, { method: 'DELETE' });
}

// Reconciles a Person's topicPreference rows to match the desired set of
// Twenty topic ids exactly - creates what's missing, deletes what's no
// longer wanted, leaves matches untouched. Idempotent: calling twice with
// the same desired set is a no-op the second time.
export async function syncPersonTopicPreferences(personId: string, desiredTopicIds: string[]): Promise<void> {
  const existing = await getPersonTopicPreferences(personId);
  const desired = new Set(desiredTopicIds);
  const existingByTopicId = new Map(existing.map((r) => [r.topicId, r.id]));

  const toCreate = desiredTopicIds.filter((id) => !existingByTopicId.has(id));
  const toDelete = existing.filter((r) => !desired.has(r.topicId));

  await Promise.all([
    ...toCreate.map((topicId) => createTopicPreference(personId, topicId)),
    ...toDelete.map((r) => deleteTopicPreference(r.id)),
  ]);
}

export async function syncPersonGeographyPreferences(
  personId: string,
  desiredGeographyIds: string[]
): Promise<void> {
  const existing = await getPersonGeographyPreferences(personId);
  const desired = new Set(desiredGeographyIds);
  const existingByGeographyId = new Map(existing.map((r) => [r.geographyId, r.id]));

  const toCreate = desiredGeographyIds.filter((id) => !existingByGeographyId.has(id));
  const toDelete = existing.filter((r) => !desired.has(r.geographyId));

  await Promise.all([
    ...toCreate.map((geographyId) => createGeographyPreference(personId, geographyId)),
    ...toDelete.map((r) => deleteGeographyPreference(r.id)),
  ]);
}

// Logto's subscription_tier custom-data value ('free'/'standard'/
// 'professional', lowercase) vs Twenty's subscriberTier SELECT options
// (FREE/STANDARD/PROFESSIONAL, uppercase, confirmed via
// /rest/metadata/objects - no ENTERPRISE option exists in this version,
// Enterprise accounts are handled manually per the technical notes).
const SUBSCRIBER_TIER_MAP: Record<string, string> = {
  free: 'FREE',
  standard: 'STANDARD',
  professional: 'PROFESSIONAL',
};

export async function syncSubscriberTier(personId: string, logtoTier: string): Promise<void> {
  const twentyTier = SUBSCRIBER_TIER_MAP[logtoTier];
  if (!twentyTier) {
    console.warn(`[twentyClient] unrecognized subscription_tier "${logtoTier}", not writing subscriberTier`);
    return;
  }
  await updatePerson(personId, { subscriberTier: twentyTier });
}

// Used for duplicate-prevention on the threshold-crossing task trigger.
// Note: the taskTargets response's own personId/person fields come back
// null even when the filter matched correctly (confirmed against the live
// instance) - don't rely on echoed identity fields, only on the expanded
// `task` object, which does resolve correctly with depth=1.
export async function findOpenEngagementTaskForPerson(
  personId: string,
  markerPrefix: string
): Promise<TwentyTask | null> {
  const encoded = encodeURIComponent(`personId[eq]:"${personId}"`);
  const data = await request<{ taskTargets: { task: TwentyTask | null }[] }>(
    `/rest/taskTargets?filter=${encoded}&depth=1&limit=50`
  );
  const match = data.taskTargets.find(
    (tt) => tt.task && tt.task.status !== 'DONE' && tt.task.title.startsWith(markerPrefix)
  );
  return match?.task ?? null;
}
