const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const paymentRepository = require('./payment.repository');
const fundingService = require('./funding.service');
const { getProvider } = require('./providers');
const { isValidSignature } = require('./signature');

/**
 * Handle one webhook delivery. `rawBody` is the exact bytes received (the signature is over
 * those bytes, so the body must NOT be parsed and re-serialised first).
 *
 *   1. Signature (HMAC SHA512, constant time). Missing or wrong -> 401, nothing else happens.
 *   2. Record the event once (UNIQUE provider + event key). A delivery whose event was already
 *      processed is acknowledged and ignored: this is what makes duplicates harmless.
 *   3. charge.success -> settle (re-verify with the provider, then credit exactly once).
 *      Any other event is stored and acknowledged.
 *
 * If settling throws (provider unreachable, database down) the event stays unprocessed and the
 * error propagates (5xx), so the provider's own retry delivers it again.
 */
async function handleWebhook(rawBody, signature) {
  const provider = getProvider();
  if (!Buffer.isBuffer(rawBody) || !isValidSignature(rawBody, signature, provider.secret)) {
    throw AppError.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw AppError.badRequest('Webhook body is not valid JSON');
  }
  const eventType = payload && payload.event;
  const data = (payload && payload.data) || {};
  if (typeof eventType !== 'string') throw AppError.badRequest('Webhook has no event type');

  const eventKey = `${eventType}:${data.reference || ''}:${data.id || ''}`;
  const { inserted, event } = await paymentRepository.recordWebhookEvent({
    provider: provider.name,
    eventKey,
    eventType,
    payload,
  });
  if (!inserted && event.processedAt) return { duplicate: true, outcome: event.outcome };

  let outcome = 'ignored';
  if (eventType === 'charge.success') {
    if (typeof data.reference !== 'string') throw AppError.badRequest('charge.success has no reference');
    outcome = await fundingService.settleByReference(data.reference);
  }
  await paymentRepository.markWebhookProcessed(event.id, outcome);
  logger.info({ eventType, reference: data.reference, outcome }, 'Webhook processed');
  return { duplicate: false, outcome };
}

module.exports = { handleWebhook };
