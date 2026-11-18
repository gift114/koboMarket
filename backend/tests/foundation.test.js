const request = require('supertest');
const createApp = require('../src/app');
const { commissionKobo, splitCommission, nairaToKobo, formatNaira } = require('../src/utils/money');

const app = createApp();

describe('Foundation: HTTP layer', () => {
  test('GET /api/v1/health returns ok with a request id header', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  test('a caller-supplied request id is echoed back', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'test-request-id-1234');
    expect(res.headers['x-request-id']).toBe('test-request-id-1234');
  });

  test('unknown route returns the standard error shape', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'ROUTE_NOT_FOUND', message: expect.any(String), details: null },
    });
  });

  test('malformed JSON returns a 400 in the standard error shape', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{ bad json');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  test('Swagger UI is served at /api-docs', async () => {
    const res = await request(app).get('/api-docs/').redirects(1);
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  test('security headers from Helmet are present', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Foundation: money helpers (integer kobo only)', () => {
  test('5% commission on N10,000 is N500', () => {
    expect(commissionKobo(1000000, 500)).toBe(50000);
  });

  test('commission rounds down and vendor + commission always equals the amount', () => {
    const { commissionKobo: c, vendorKobo: v } = splitCommission(333, 500);
    expect(c).toBe(16);
    expect(v).toBe(317);
    expect(c + v).toBe(333);
  });

  test('floats are rejected', () => {
    expect(() => commissionKobo(10.5, 500)).toThrow();
    expect(() => commissionKobo(1000, 5.5)).toThrow();
  });

  test('naira strings convert to integer kobo without float math', () => {
    expect(nairaToKobo('1500.50')).toBe(150050);
    expect(nairaToKobo('1000')).toBe(100000);
    expect(formatNaira(150050)).toBe('N1,500.50');
  });
});
