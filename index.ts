// Webhook receiver. Routes incoming webhooks to the relevant connector.
// See Appendix D of the CRM data model doc for the overall service architecture.

import crypto from 'crypto';
import express from 'express';
import { handleLogtoWebhook, LogtoWebhookPayload } from './connectors/logto';

const PORT = process.env.PORT || 3000;
const LOGTO_WEBHOOK_SIGNING_KEY = process.env.LOGTO_WEBHOOK_SIGNING_KEY;

if (!LOGTO_WEBHOOK_SIGNING_KEY) {
  throw new Error('LOGTO_WEBHOOK_SIGNING_KEY environment variable is required');
}

const app = express();

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

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`crm-sync listening on port ${PORT}`);
});
