// Logto connector (Stage 1 scaffold, extended Meridian Phase 8a).
// Handles two families of Logto webhook event:
//
//  - PostRegister (interaction hook): fires when a real user completes the
//    hosted sign-up flow (Experience API). This is the actual "someone
//    signed up for Meridian Insights" event, and until this phase the
//    service was never subscribed to it - see the phase's build notes.
//  - User.Created (data-mutation hook): fires for users created directly
//    via the Management API (e.g. QA test accounts).
//  - User.Data.Updated (data-mutation hook): fires for ANY Management API
//    call that touches a user's data, not just profile edits - see
//    CustomDataUpdatedPayload's comment below for its real payload shape,
//    only confirmed live during Phase 14.
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
import {
  findPersonByLogtoUserId,
  syncPersonGeographyPreferences,
  syncPersonTopicPreferences,
  syncSubscriberTier,
  upsertPersonForSignup,
} from '../lib/twentyClient';

// Partial shape of Logto's webhook payload for User.Created. See
// https://docs.logto.io/developers/webhooks/webhooks-request - only the
// fields this connector reads are typed here.
type LogtoUserEventData = {
  id: string;
  name: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
};

type DataMutationPayload = {
  event: 'User.Created';
  createdAt: string;
  data: LogtoUserEventData;
};

// User.Data.Updated's real payload shape, confirmed 2026-07-21 against a
// live Logto hook delivery log (Meridian Phase 14 build) - this is NOT a
// "here's the updated user object" event like User.Created. It's Logto's
// generic "an API call touched this user's data" envelope: whichever
// Management API endpoint fired it, `data.data` is that call's own request
// body verbatim and `data.params.userId` is the affected user's id. A prior
// version of this connector assumed a flat user-object shape here
// (`data.id`/`data.name`/...) - that was never actually exercised by a
// real webhook before this phase (confirmed: this hook's delivery log had
// exactly zero prior User.Data.Updated entries), and the wrong assumption
// caused a real bug caught during this phase's live verification: a blank
// Person record got created in the shared Twenty tenant from a call with
// no real `id`. Fixed below by reading the real fields and never creating
// a Person from this event - see handleDataUpdated.
type CustomDataUpdatedPayload = {
  event: 'User.Data.Updated';
  createdAt: string;
  data: {
    path: string;
    method: string;
    params: { userId?: string };
    data: {
      topic_crm_ids?: string[];
      geography_crm_ids?: string[];
      subscription_tier?: string;
      [key: string]: unknown;
    };
  };
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

export type LogtoWebhookPayload =
  | DataMutationPayload
  | CustomDataUpdatedPayload
  | InteractionHookPayload
  | { event: string; [key: string]: unknown };

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
    await handleDataUpdated((payload as CustomDataUpdatedPayload).data);
    return;
  }

  // Any other subscribed event this hook isn't built to handle yet - ignore
  // rather than error, so an unrelated future event type added to the same
  // hook doesn't take the whole webhook down.
}

// Meridian Phase 14 - reconciles topic/geography preferences and
// subscriber tier from a custom-data PATCH onto the linked Twenty Person.
// `patch` is exactly the request body of whichever Management API call
// fired this event (crm-sync's own crm_person_id writeback, the portal's
// preference save, or Adam manually flipping subscription_tier in Logto's
// console all land here identically) - only the recognised keys are acted
// on, anything else (e.g. crm_person_id echoing back from this connector's
// own signup writeback) is silently a no-op, not an error.
//
// Deliberately never creates a Person - a custom-data PATCH is not a
// signup, and this payload carries no identity fields to create one from
// correctly. If no Person is linked to this Logto user yet (shouldn't
// happen outside a race with signup sync), this logs and skips rather than
// guessing - the bug this replaced did exactly that guessing and created a
// blank Person in the shared Twenty tenant, caught during this phase's
// live verification.
async function handleDataUpdated(data: CustomDataUpdatedPayload['data']): Promise<void> {
  const logtoUserId = data.params?.userId;
  if (!logtoUserId) {
    console.warn('[logto-sync] User.Data.Updated payload had no params.userId, skipping', JSON.stringify(data));
    return;
  }

  const patch = data.data ?? {};
  const hasRecognisedKey =
    Array.isArray(patch.topic_crm_ids) || Array.isArray(patch.geography_crm_ids) || typeof patch.subscription_tier === 'string';
  if (!hasRecognisedKey) return;

  const person = await findPersonByLogtoUserId(logtoUserId);
  if (!person) {
    console.warn(`[logto-sync] User.Data.Updated for ${logtoUserId} but no linked Person found yet - skipping`);
    return;
  }

  if (Array.isArray(patch.topic_crm_ids)) {
    await syncPersonTopicPreferences(person.id, patch.topic_crm_ids);
  }
  if (Array.isArray(patch.geography_crm_ids)) {
    await syncPersonGeographyPreferences(person.id, patch.geography_crm_ids);
  }
  if (typeof patch.subscription_tier === 'string') {
    await syncSubscriberTier(person.id, patch.subscription_tier);
  }
  console.log(`[logto-sync] User.Data.Updated: synced preferences/tier for Logto user ${logtoUserId}`);
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
