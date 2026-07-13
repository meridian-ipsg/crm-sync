// Thin wrapper around Payload's REST API for the meridian-insights-website
// app, using a dedicated admin-level service-account API key (Topic/
// Geography/Sector are locked to admin-only read/write per that app's
// Phase 3 access control, so a normal session can't write here — see
// meridian-insights-website's Phase 7 commit enabling Users.auth.useAPIKey).
// Every write this service makes to Payload goes through this file.

const BASE_URL = process.env.PAYLOAD_BASE_URL || 'https://meridian-insights.com';
const API_KEY = process.env.PAYLOAD_API_KEY;

if (!API_KEY) {
  throw new Error('PAYLOAD_API_KEY environment variable is required');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE_URL + path, {
    ...init,
    headers: {
      // Payload's API-key auth header format: "<collection-slug> API-Key <key>".
      Authorization: `users API-Key ${API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json as T;
}

export type TaxonomyCollection = 'topics' | 'geographies' | 'sectors';

export type TaxonomyRecord = {
  id: number;
  name: string;
  slug: string;
  crm_id?: string | null;
};

function encodeWhere(field: string, value: string): string {
  return `where[${field}][equals]=${encodeURIComponent(value)}`;
}

export async function findTaxonomyByCrmId(
  collection: TaxonomyCollection,
  crmId: string
): Promise<TaxonomyRecord | null> {
  const data = await request<{ docs: TaxonomyRecord[] }>(`/api/${collection}?${encodeWhere('crm_id', crmId)}&limit=1`);
  return data.docs[0] ?? null;
}

export async function findTaxonomyBySlug(
  collection: TaxonomyCollection,
  slug: string
): Promise<TaxonomyRecord | null> {
  const data = await request<{ docs: TaxonomyRecord[] }>(`/api/${collection}?${encodeWhere('slug', slug)}&limit=1`);
  return data.docs[0] ?? null;
}

export async function findTaxonomyByName(
  collection: TaxonomyCollection,
  name: string
): Promise<TaxonomyRecord | null> {
  const data = await request<{ docs: TaxonomyRecord[] }>(`/api/${collection}?${encodeWhere('name', name)}&limit=1`);
  return data.docs[0] ?? null;
}

export async function createTaxonomy(
  collection: TaxonomyCollection,
  fields: { name: string; slug: string; crm_id: string }
): Promise<TaxonomyRecord> {
  const data = await request<{ doc: TaxonomyRecord }>(`/api/${collection}`, {
    method: 'POST',
    body: JSON.stringify(fields),
  });
  return data.doc;
}

export async function updateTaxonomy(
  collection: TaxonomyCollection,
  id: number,
  fields: Partial<{ name: string; slug: string; crm_id: string }>
): Promise<TaxonomyRecord> {
  const data = await request<{ doc: TaxonomyRecord }>(`/api/${collection}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  return data.doc;
}
