// Meridian Phase 9 — Enterprise lead-capture task creation. Triggered
// best-effort by meridian-insights-website's /api/lead route after its
// existing Resend notification email succeeds; this is additive to that
// email, not a replacement for it, and the website route treats a failure
// here as non-fatal to the user's submission.
//
// Deliberately does not create or adopt a Twenty Person - matching an
// enquiry to an existing consulting relationship by email is attempted
// (so Mark sees the task on the right record if one already exists), but
// creating a new Person from an inbound enquiry is identity-sync scope
// (Phase 8a's territory), not this connector's.

import { createTask, findPersonByEmail, linkTaskToPerson } from '../lib/twentyClient';
import { engagementConfig } from '../lib/engagementConfig';

export type LeadCapturePayload = {
  name: string;
  email: string;
  organisation?: string;
  interest?: string;
};

export async function handleLeadCapture(payload: LeadCapturePayload): Promise<void> {
  const { name, email, organisation, interest } = payload;

  const bodyLines = [
    `Email: ${email}`,
    organisation ? `Organisation: ${organisation}` : null,
    interest ? `Interest: ${interest}` : null,
  ].filter((line): line is string => line !== null);

  const task = await createTask({
    title: `[Lead] Enterprise enquiry — ${name}${organisation ? ` (${organisation})` : ''}`,
    bodyMarkdown: bodyLines.join('\n'),
    assigneeId: engagementConfig.markWorkspaceMemberId,
    dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const existingPerson = await findPersonByEmail(email);
  if (existingPerson) {
    await linkTaskToPerson(task.id, existingPerson.id);
    console.log(`[lead-capture] task ${task.id} created and linked to existing Person ${existingPerson.id} (${email})`);
  } else {
    console.log(`[lead-capture] task ${task.id} created, no existing Person matched ${email} - left unlinked`);
  }
}
