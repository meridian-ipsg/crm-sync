// Thin wrapper around Twenty's REST API. Every connector goes through this
// rather than calling fetch() directly, so auth and error handling live in
// one place. See Appendix D of the CRM data model doc.

const BASE_URL = process.env.TWENTY_BASE_URL || 'https://crm.ipsg.com.au';
const TOKEN = process.env.TWENTY_API_TOKEN;

if (!TOKEN) {
  throw new Error('TWENTY_API_TOKEN environment variable is required');
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
    throw new Error(`${init.method || 'GET'} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
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
