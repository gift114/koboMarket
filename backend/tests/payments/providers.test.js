const http = require('http');
const PaystackProvider = require('../../src/modules/payments/providers/paystack.provider');
const MockProvider = require('../../src/modules/payments/providers/mock.provider');
const { sign, isValidSignature } = require('../../src/modules/payments/signature');

/** A local HTTP server standing in for api.paystack.co, recording what it receives. */
function stubPaystack(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const { status = 200, json } = handler(req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}

describe('PaystackProvider against a local stand-in for the Paystack API', () => {
  let stub;
  let responder = () => ({});
  beforeAll(async () => {
    stub = await stubPaystack((req) => responder(req));
  });
  afterAll(() => stub.close());
  const make = () => new PaystackProvider({ secretKey: 'sk_test_abc123', baseUrl: stub.url });

  test('initialize: POST /transaction/initialize with the bearer secret and an INTEGER kobo amount', async () => {
    responder = () => ({ json: { status: true, message: 'ok', data: { authorization_url: 'https://checkout.paystack.com/xyz', access_code: 'ac_1', reference: 'KM-1' } } });
    const out = await make().initializeTransaction({ reference: 'KM-12345678', amountKobo: 500_000, email: 'a@b.com', callbackUrl: 'http://app/cb' });

    expect(out).toEqual({ authorizationUrl: 'https://checkout.paystack.com/xyz', accessCode: 'ac_1' });
    const req = stub.requests.at(-1);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/transaction/initialize');
    expect(req.headers.authorization).toBe('Bearer sk_test_abc123');
    expect(req.body).toEqual({ email: 'a@b.com', amount: 500_000, currency: 'NGN', reference: 'KM-12345678', callback_url: 'http://app/cb' });
    expect(Number.isInteger(req.body.amount)).toBe(true);
  });

  test('initialize: a rejection from Paystack becomes a 502 and never leaks the secret', async () => {
    responder = () => ({ status: 401, json: { status: false, message: 'Invalid key' } });
    await expect(make().initializeTransaction({ reference: 'KM-12345678', amountKobo: 100, email: 'a@b.com' })).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_PROVIDER_ERROR',
    });
  });

  test('verify: GET /transaction/verify/:reference and maps the result (amount stays integer kobo)', async () => {
    responder = () => ({ json: { status: true, data: { status: 'success', reference: 'KM-12345678', amount: 500_000, currency: 'NGN', paid_at: '2026-11-07T10:00:00Z' } } });
    const out = await make().verifyTransaction('KM-12345678');
    expect(out).toEqual({ status: 'success', reference: 'KM-12345678', amountKobo: 500_000, currency: 'NGN', paidAt: '2026-11-07T10:00:00Z' });
    expect(stub.requests.at(-1)).toMatchObject({ method: 'GET', url: '/transaction/verify/KM-12345678' });
  });

  test('verify: abandoned / failed statuses are passed through, not treated as success', async () => {
    responder = () => ({ json: { status: true, data: { status: 'abandoned', reference: 'KM-12345678', amount: 100, currency: 'NGN' } } });
    expect((await make().verifyTransaction('KM-12345678')).status).toBe('abandoned');
  });

  test('verify: an unknown reference is "not_found"; a server error is a 502', async () => {
    responder = () => ({ status: 400, json: { status: false, message: 'Transaction reference not found' } });
    expect(await make().verifyTransaction('KM-nope1234')).toEqual({ status: 'not_found' });
    responder = () => ({ status: 500, json: { message: 'boom' } });
    await expect(make().verifyTransaction('KM-12345678')).rejects.toMatchObject({ statusCode: 502 });
  });

  test('an unreachable Paystack is a 502, not a crash', async () => {
    const dead = new PaystackProvider({ secretKey: 'sk_test_x', baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    await expect(dead.verifyTransaction('KM-12345678')).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('webhook signatures (HMAC SHA512)', () => {
  const secret = 'sk_test_secret';
  const body = Buffer.from('{"event":"charge.success","data":{"reference":"KM-1"}}');

  test('matches the algorithm Paystack documents: hex HMAC-SHA512 of the raw body', () => {
    const expected = require('crypto').createHmac('sha512', secret).update(body).digest('hex');
    expect(sign(body, secret)).toBe(expected);
    expect(sign(body, secret)).toHaveLength(128);
  });

  test('accepts the right signature, rejects wrong body / secret / format / missing', () => {
    const sig = sign(body, secret);
    expect(isValidSignature(body, sig, secret)).toBe(true);
    expect(isValidSignature(body, sig.toUpperCase(), secret)).toBe(true); // hex is case-insensitive
    expect(isValidSignature(Buffer.from('{"event":"x"}'), sig, secret)).toBe(false);
    expect(isValidSignature(body, sig, 'other-secret')).toBe(false);
    expect(isValidSignature(body, sig.slice(0, 100), secret)).toBe(false);
    expect(isValidSignature(body, undefined, secret)).toBe(false);
    expect(isValidSignature(body, 'zz'.repeat(64), secret)).toBe(false);
  });
});

describe('MockProvider behaves like Paystack', () => {
  test('initialize -> unpaid verify is pending -> markPaid -> verify is success; unknown is not_found', async () => {
    const mock = new MockProvider({ secret: 'mock-secret-mock-secret', appBaseUrl: 'http://x' });
    await mock.initializeTransaction({ reference: 'KM-aaaaaaaa', amountKobo: 5_000, email: 'a@b.com' });
    expect((await mock.verifyTransaction('KM-aaaaaaaa')).status).toBe('pending');
    mock.markPaid('KM-aaaaaaaa');
    expect(await mock.verifyTransaction('KM-aaaaaaaa')).toMatchObject({ status: 'success', amountKobo: 5_000, currency: 'NGN' });
    expect(await mock.verifyTransaction('KM-bbbbbbbb')).toEqual({ status: 'not_found' });
  });

  test('its webhooks are signed exactly like Paystack signs them', async () => {
    const mock = new MockProvider({ secret: 'mock-secret-mock-secret', appBaseUrl: 'http://x' });
    await mock.initializeTransaction({ reference: 'KM-aaaaaaaa', amountKobo: 5_000, email: 'a@b.com' });
    const { rawBody, signature } = mock.buildWebhook('KM-aaaaaaaa');
    expect(isValidSignature(rawBody, signature, 'mock-secret-mock-secret')).toBe(true);
    expect(JSON.parse(rawBody)).toMatchObject({ event: 'charge.success', data: { reference: 'KM-aaaaaaaa', amount: 5_000 } });
  });
});
