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
// Used by connectors/logto.ts for both User.Created and User.Data.Updated events.
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
