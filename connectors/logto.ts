// Logto connector (Stage 1 scaffold, extended Meridian Phase 8a).
// Handles two families of Logto webhook event:
//
//  - PostRegister (interaction hook): fires when a real user completes the
//    hosted sign-up flow (Experience API). This is the actual "someone
//    signed up for Meridian Insights" event, and until this phase the
//    service was never subscribed to it - see the phase's build notes.
//  - User.Created / User.Data.Updated (data-mutation hooks): fire for
//    users created/edited directly via the Management API (e.g. QA test
//    accounts), and for profile edits after signup. Kept working exactly
//    as before.
//
// On a signup (PostRegister, or a Management-API User.Created), this
// connector upserts the corresponding Twenty Person - adopting an existing
// Person by email match rather than creating a duplicate, since Meridian
// and IPSG share one Twenty instance - and writes the resulting Person's
// Twenty id back onto the Logto user's custom data as `crm_person_id`
// (the field Phase 3 built as manually-settable, now populated for real).
//
// Twenty is the source of truth for everything else on the Person record -
// this connector only ever writes the identity fields it owns.

import parsePhoneNumber from 'libphonenumber-js';
import { updateUserCustomData } from '../lib/logtoClient';
import { upsertPersonByLogtoUserId, upsertPersonForSignup } from '../lib/twentyClient';

// Partial shape of Logto's webhook payload for the data-mutation events
// (User.Created / User.Data.Updated). See
// https://docs.logto.io/developers/webhooks/webhooks-request - only the
// fields this connector reads are typed here.
type LogtoUserEventData = {
  id: string;
  name: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
};

type DataMutationPayload = {
  event: 'User.Created' | 'User.Data.Updated';
  createdAt: string;
  data: LogtoUserEventData;
};

// Interaction hook payload shape (PostRegister). Distinct envelope from the
// data-mutation events above - the affected user is a top-level `user`
// object, not `data`.
type InteractionHookPayload = {
  event: 'PostRegister';
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    primaryEmail: string | null;
    primaryPhone: string | null;
  };
};

export type LogtoWebhookPayload = DataMutationPayload | InteractionHookPayload | { event: string; [key: string]: unknown };

type NormalizedUser = {
  id: string;
  name: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
};

function splitName(name: string | null): { firstName: string; lastName: string } {
  if (!name) return { firstName: '', lastName: '' };
  const [firstName, ...rest] = name.trim().split(/\s+/);
  return { firstName, lastName: rest.join(' ') };
}

function buildIdentityFields(user: NormalizedUser): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    name: splitName(user.name),
  };
  if (user.primaryEmail) {
    fields.emails = { primaryEmail: user.primaryEmail, additionalEmails: [] };
  }
  if (user.primaryPhone) {
    // Logto stores primaryPhone in E.164 (e.g. "+61400000000"); Twenty's phone
    // field wants the calling code and national number split apart.
    const parsed = parsePhoneNumber(user.primaryPhone);
    if (parsed) {
      fields.phones = {
        primaryPhoneNumber: parsed.nationalNumber,
        primaryPhoneCountryCode: parsed.country ?? '',
        primaryPhoneCallingCode: `+${parsed.countryCallingCode}`,
        additionalPhones: [],
      };
    } else {
      console.warn(`could not parse phone number "${user.primaryPhone}" for Logto user ${user.id}, skipping phone field`);
    }
  }
  return fields;
}

export async function handleLogtoWebhook(payload: LogtoWebhookPayload): Promise<void> {
  if (payload.event === 'PostRegister') {
    const { user } = payload as InteractionHookPayload;
    await handleSignup(user);
    return;
  }

  if (payload.event === 'User.Created') {
    const { data } = payload as DataMutationPayload;
    await handleSignup(data);
    return;
  }

  if (payload.event === 'User.Data.Updated') {
    const { data } = payload as DataMutationPayload;
    const fields = buildIdentityFields(data);
    await upsertPersonByLogtoUserId(data.id, fields);
    console.log(`[logto-sync] User.Data.Updated: refreshed Person identity fields for Logto user ${data.id}`);
    return;
  }

  // Any other subscribed event this hook isn't built to handle yet - ignore
  // rather than error, so an unrelated future event type added to the same
  // hook doesn't take the whole webhook down.
}

async function handleSignup(user: NormalizedUser): Promise<void> {
  const fields = buildIdentityFields(user);

  let person;
  let outcome;
  try {
    ({ person, outcome } = await upsertPersonForSignup(user.id, user.primaryEmail, fields));
  } catch (err) {
    console.error(`[logto-sync] signup sync FAILED for Logto user ${user.id} (${user.primaryEmail ?? 'no email'}):`, err);
    throw err;
  }

  console.log(
    `[logto-sync] signup sync: ${outcome} Person ${person.id} for Logto user ${user.id} (${user.primaryEmail ?? 'no email'})`
  );

  try {
    await updateUserCustomData(user.id, { crm_person_id: person.id });
    console.log(`[logto-sync] wrote crm_person_id=${person.id} back to Logto user ${user.id}`);
  } catch (err) {
    console.error(
      `[logto-sync] Person ${outcome} in Twenty (${person.id}) but writing crm_person_id back to Logto user ${user.id} FAILED:`,
      err
    );
    throw err;
  }
}
