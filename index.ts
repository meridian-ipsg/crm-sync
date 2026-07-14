// Webhook receiver. Routes incoming webhooks to the relevant connector.
// See Appendix D of the CRM data model doc for the overall service architecture.

import crypto from 'crypto';
import express from 'express';
import cron from 'node-cron';
import { handleLogtoWebhook, LogtoWebhookPayload } from './connectors/logto';
import { runNightlyTaxonomySync } from './jobs/nightlyTaxonomySync';
import { runNightlyEngagementSync } from './jobs/nightlyEngagementSync';
import { handleLeadCapture, LeadCapturePayload } from './connectors/leadCapture';

const PORT = process.env.PORT || 3000;
const LOGTO_WEBHOOK_SIGNING_KEY = process.env.LOGTO_WEBHOOK_SIGNING_KEY;
const SYNC_TRIGGER_TOKEN = process.env.SYNC_TRIGGER_TOKEN;

if (!LOGTO_WEBHOOK_SIGNING_KEY) {
  throw new Error('LOGTO_WEBHOOK_SIGNING_KEY environment variable is required');
}
if (!SYNC_TRIGGER_TOKEN) {
  throw new Error('SYNC_TRIGGER_TOKEN environment variable is required');
}

const app = express();

// Shared-secret bearer check used by every internal trigger endpoint below
// (not the Logto webhook, which verifies via HMAC signature instead since
// that's actually authenticating an external system, not gating an
// internal trigger against anyone who doesn't have the token).
function isValidBearer(req: express.Request, expectedToken: string): boolean {
  const auth = req.header('authorization');
  const expected = `Bearer ${expectedToken}`;
  const authBuffer = auth ? Buffer.from(auth) : null;
  const expectedBuffer = Buffer.from(expected);
  return authBuffer !== null && authBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(authBuffer, expectedBuffer);
}

// Logto signs the raw body, so this route needs the raw buffer, not JSON-parsed.
app.post('/webhooks/logto', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.header('logto-signature-sha-256');
  const expected = crypto
    .createHmac('sha256', LOGTO_WEBHOOK_SIGNING_KEY as string)
    .update(req.body)
    .digest('hex');

  // timingSafeEqual throws on length mismatch rather than returning false,
  // so the length check must happen first.
  const signatureBuffer = signature ? Buffer.from(signature) : null;
  const expectedBuffer = Buffer.from(expected);
  const isValid =
    signatureBuffer !== null &&
    signatureBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

  if (!isValid) {
    res.status(401).send('invalid signature');
    return;
  }

  const payload = JSON.parse(req.body.toString('utf8')) as LogtoWebhookPayload;

  try {
    await handleLogtoWebhook(payload);
    res.status(200).send('ok');
  } catch (err) {
    console.error('logto webhook handling failed', err);
    res.status(500).send('internal error');
  }
});

// Manual re-sync trigger for Phase 7's taxonomy connector.
app.post('/sync/taxonomy', express.json(), async (req, res) => {
  if (!isValidBearer(req, SYNC_TRIGGER_TOKEN as string)) {
    res.status(401).send('invalid token');
    return;
  }

  try {
    await runNightlyTaxonomySync();
    res.status(200).send('ok');
  } catch (err) {
    console.error('manual taxonomy sync trigger failed', err);
    res.status(500).send('internal error');
  }
});

// Manual trigger for Phase 9's engagement scoring job — same trigger token,
// same pattern as the taxonomy sync above.
app.post('/sync/engagement', express.json(), async (req, res) => {
  if (!isValidBearer(req, SYNC_TRIGGER_TOKEN as string)) {
    res.status(401).send('invalid token');
    return;
  }

  try {
    await runNightlyEngagementSync();
    res.status(200).send('ok');
  } catch (err) {
    console.error('manual engagement sync trigger failed', err);
    res.status(500).send('internal error');
  }
});

// Phase 9's Enterprise lead-capture trigger — called best-effort by
// meridian-insights-website's /api/lead route after its Resend email
// succeeds. Reuses the same trigger token rather than provisioning a
// separate secret for one more internal caller.
app.post('/webhooks/lead-capture', express.json(), async (req, res) => {
  if (!isValidBearer(req, SYNC_TRIGGER_TOKEN as string)) {
    res.status(401).send('invalid token');
    return;
  }

  try {
    await handleLeadCapture(req.body as LeadCapturePayload);
    res.status(200).send('ok');
  } catch (err) {
    console.error('lead capture task creation failed', err);
    res.status(500).send('internal error');
  }
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`crm-sync listening on port ${PORT}`);

  // Nightly taxonomy sync (Phase 7), 02:00 server time daily. In-process
  // scheduler rather than relying on an external cron being configured
  // separately — guarantees the schedule is active for as long as this
  // service is deployed, per the phase's "will run without further
  // intervention" requirement.
  cron.schedule('0 2 * * *', () => {
    runNightlyTaxonomySync().catch((err) => {
      console.error('[taxonomy-sync] scheduled run threw unexpectedly', err);
    });
  });
  console.log('[taxonomy-sync] nightly schedule registered (02:00 daily)');

  // Nightly engagement scoring (Phase 9), 03:00 server time daily — after
  // the taxonomy sync, no dependency between them, just avoids both jobs
  // hitting Twenty at the exact same minute.
  cron.schedule('0 3 * * *', () => {
    runNightlyEngagementSync().catch((err) => {
      console.error('[engagement-sync] scheduled run threw unexpectedly', err);
    });
  });
  console.log('[engagement-sync] nightly schedule registered (03:00 daily)');
});
