// Stage 1 connector (build now, per Appendix D of the CRM data model doc).
// Handles Logto's User.Created / User.Data.Updated webhooks and syncs
// Person identity fields into Twenty. Twenty is the source of truth for
// everything else on the Person record - this connector only ever writes
// the identity fields it owns.

import parsePhoneNumber from 'libphonenumber-js';
import { upsertPersonByLogtoUserId } from '../lib/twentyClient';

// Partial shape of Logto's webhook payload `data` field for User.* events.
// See https://docs.logto.io/docs/recipes/webhooks/ for the full schema -
// only the fields this connector reads are typed here.
export type LogtoUserEventData = {
  id: string;
  name: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
};

export type LogtoWebhookPayload = {
  event: 'User.Created' | 'User.Data.Updated' | string;
  createdAt: string;
  data: LogtoUserEventData;
};

function splitName(name: string | null): { firstName: string; lastName: string } {
  if (!name) return { firstName: '', lastName: '' };
  const [firstName, ...rest] = name.trim().split(/\s+/);
  return { firstName, lastName: rest.join(' ') };
}

export async function handleLogtoWebhook(payload: LogtoWebhookPayload): Promise<void> {
  if (payload.event !== 'User.Created' && payload.event !== 'User.Data.Updated') {
    return;
  }

  const { id, name, primaryEmail, primaryPhone } = payload.data;

  const fields: Record<string, unknown> = {
    name: splitName(name),
  };
  if (primaryEmail) {
    fields.emails = { primaryEmail, additionalEmails: [] };
  }
  if (primaryPhone) {
    // Logto stores primaryPhone in E.164 (e.g. "+61400000000"); Twenty's phone
    // field wants the calling code and national number split apart.
    const parsed = parsePhoneNumber(primaryPhone);
    if (parsed) {
      fields.phones = {
        primaryPhoneNumber: parsed.nationalNumber,
        primaryPhoneCountryCode: parsed.country ?? '',
        primaryPhoneCallingCode: `+${parsed.countryCallingCode}`,
        additionalPhones: [],
      };
    } else {
      console.warn(`could not parse phone number "${primaryPhone}" for Logto user ${id}, skipping phone field`);
    }
  }

  await upsertPersonByLogtoUserId(id, fields);
}
