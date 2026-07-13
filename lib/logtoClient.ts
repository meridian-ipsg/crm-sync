// Thin wrapper around Logto's Management API, used only to write
// `crm_person_id` back onto a user's custom data after a signup syncs to
// Twenty (Meridian Phase 8a). Reuses the `crm-sync` M2M application created
// during Phase 7 for this exact purpose but never wired up until now.
//
// A fresh client-credentials token is fetched per call rather than cached -
// signups are low-frequency (nowhere near enough volume to make token
// reuse worth the invalidation-bug surface).

const LOGTO_ENDPOINT = process.env.LOGTO_ENDPOINT || 'https://auth.ipsg.com.au';
const LOGTO_M2M_APP_ID = process.env.LOGTO_M2M_APP_ID;
const LOGTO_M2M_APP_SECRET = process.env.LOGTO_M2M_APP_SECRET;
const MANAGEMENT_API_RESOURCE = process.env.LOGTO_MANAGEMENT_API_RESOURCE || 'https://default.logto.app/api';

if (!LOGTO_M2M_APP_ID || !LOGTO_M2M_APP_SECRET) {
  throw new Error('LOGTO_M2M_APP_ID and LOGTO_M2M_APP_SECRET environment variables are required');
}

async function getManagementApiToken(): Promise<string> {
  const res = await fetch(`${LOGTO_ENDPOINT}/oidc/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${LOGTO_M2M_APP_ID}:${LOGTO_M2M_APP_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: MANAGEMENT_API_RESOURCE,
      scope: 'all',
    }),
  });
  const json = (await res.json()) as { access_token?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Logto token request failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

// PATCH /api/users/:id/custom-data performs a partial merge, not a
// replace - safe to call without first reading the user's existing
// custom data (e.g. subscription_tier, set independently elsewhere).
export async function updateUserCustomData(logtoUserId: string, patch: Record<string, unknown>): Promise<void> {
  const token = await getManagementApiToken();
  const res = await fetch(`${LOGTO_ENDPOINT}/api/users/${logtoUserId}/custom-data`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ customData: patch }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PATCH /api/users/${logtoUserId}/custom-data failed (${res.status}): ${body}`);
  }
}
