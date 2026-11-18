const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const fundingService = require('./funding.service');
const webhookService = require('./webhook.service');
const { getProvider } = require('./providers');

const fund = asyncHandler(async (req, res) => {
  const payment = await fundingService.initiate(req.user, req.body);
  res.status(201).json({ success: true, data: { payment } });
});

const getFunding = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { payment: await fundingService.getStatus(req.user.id, req.params.reference) } });
});

/** Paystack (or the mock) calls this. The body is the raw Buffer (see app.js). */
const paystackWebhook = asyncHandler(async (req, res) => {
  const result = await webhookService.handleWebhook(req.body, req.get('x-paystack-signature'));
  res.status(200).json({ success: true, data: result });
});

/**
 * DEV ONLY (mock provider): "the customer pays on the gateway page". Marks the mock
 * transaction paid, then delivers the signed webhook 1 + `duplicates` times, like a real
 * provider that resends. Returns what each delivery did.
 */
const mockPay = asyncHandler(async (req, res) => {
  const provider = getProvider();
  const { outcome, duplicates, amountKobo } = req.body;
  try {
    if (outcome === 'failed') provider.markFailed(req.params.reference);
    else provider.markPaid(req.params.reference, { amountKobo });
  } catch {
    throw AppError.notFound('Unknown mock payment', 'PAYMENT_NOT_FOUND');
  }
  const deliveries = [];
  for (let i = 0; i <= duplicates; i += 1) {
    const { rawBody, signature } = provider.buildWebhook(
      req.params.reference,
      outcome === 'failed' ? 'charge.failed' : 'charge.success',
    );
    deliveries.push(await webhookService.handleWebhook(rawBody, signature));
  }
  res.json({ success: true, data: { deliveries } });
});

module.exports = { fund, getFunding, paystackWebhook, mockPay };
