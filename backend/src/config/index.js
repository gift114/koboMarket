require('dotenv').config();
const { z } = require('zod');

const int = (def) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  MONGO_URI: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: int(15),
  REFRESH_TOKEN_TTL_DAYS: int(7),
  EMAIL_VERIFICATION_TTL_HOURS: int(24),
  PASSWORD_RESET_TTL_MINUTES: int(30),

  LOGIN_MAX_FAILED_ATTEMPTS: int(5),
  LOGIN_WINDOW_MINUTES: int(15),

  RATE_LIMIT_WINDOW_MINUTES: int(15),
  RATE_LIMIT_MAX_REQUESTS: int(300),

  // Money-related business rules. Always integers: kobo, or basis points for rates.
  COMMISSION_RATE_BPS: z.coerce.number().int().min(0).max(10000).default(500),
  ESCROW_AUTO_COMPLETE_HOURS: int(72),
  ESCROW_AUTO_COMPLETE_CRON: z.string().default('0 */5 * * * *'),
  PAYOUT_MINIMUM_KOBO: int(100000),
  PAYOUT_PROCESS_CRON: z.string().default('*/30 * * * * *'),
  PAYOUT_CLAIM_LEASE_SECONDS: int(120),
  PAYOUT_BATCH_SIZE: int(10),

  // Creating the PostgreSQL wallet of each new user (see walletProvisioning.service.js).
  WALLET_PROVISION_CRON: z.string().default('*/30 * * * * *'),
  WALLET_PROVISION_GRACE_SECONDS: int(60),
  WALLET_PROVISION_MAX_BACKOFF_SECONDS: int(900),
  WALLET_PROVISION_BATCH_SIZE: int(50),

  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  AUTH_RATE_LIMIT_MAX_REQUESTS: int(20),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  FRONTEND_BASE_URL: z.string().url().default('http://localhost:5173'),

  // "console" prints emails to stdout, "smtp" sends via
  // SMTP (e.g. Mailtrap), "memory" keeps them in an array for tests.
  MAIL_TRANSPORT: z
    .enum(['console', 'smtp', 'memory'])
    .default(process.env.SMTP_HOST || process.env.EMAIL_HOST ? 'smtp' : 'console'),
  MAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_HOST: z.string().optional(),
  EMAIL_PORT: z.coerce.number().int().positive().optional(),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASSWORD: z.string().optional(),

  PAYMENT_PROVIDER: z.enum(['mock', 'paystack']).default('paystack'),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_BASE_URL: z.string().default('https://api.paystack.co'),
  // Signs the mock provider's webhooks (the real Paystack uses PAYSTACK_SECRET_KEY).
  MOCK_PAYMENT_SECRET: z.string().min(16).default('mock-payment-secret-change-me'),
  FUND_MIN_KOBO: int(10000),
  FUND_MAX_KOBO: int(500000000),

  // Idempotency-Key records are kept this long; an unfinished one can be taken over after the lock time.
  // Orders paid but whose stock step never finished are cancelled and refunded by a job.
  ORDER_RECONCILE_CRON: z.string().default('0 * * * * *'),
  CHECKOUT_STUCK_SECONDS: int(120),

  IDEMPOTENCY_TTL_HOURS: int(24),
  IDEMPOTENCY_LOCK_SECONDS: int(300),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Do not print values: they may be secrets. Print only which keys are wrong.
  const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

const env = parsed.data;
const smtpHost = env.SMTP_HOST || env.EMAIL_HOST;
const smtpUser = env.SMTP_USER || env.EMAIL_USER;
const smtpPass = env.SMTP_PASS || env.EMAIL_PASSWORD;

if (env.PAYMENT_PROVIDER === 'paystack' && !env.PAYSTACK_SECRET_KEY) {
  // eslint-disable-next-line no-console
  console.error('PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack');
  process.exit(1);
}

if (env.MAIL_TRANSPORT === 'smtp' && !smtpHost) {
  // eslint-disable-next-line no-console
  console.error('SMTP_HOST or EMAIL_HOST is required when MAIL_TRANSPORT=smtp');
  process.exit(1);
}

module.exports = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),

  mongoUri: env.MONGO_URI,
  databaseUrl: env.DATABASE_URL,

  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtlMinutes: env.ACCESS_TOKEN_TTL_MINUTES,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    emailVerificationTtlHours: env.EMAIL_VERIFICATION_TTL_HOURS,
    passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    loginMaxFailedAttempts: env.LOGIN_MAX_FAILED_ATTEMPTS,
    loginWindowMinutes: env.LOGIN_WINDOW_MINUTES,
    bcryptRounds: env.BCRYPT_ROUNDS,
    rateLimitMax: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
  },

  appBaseUrl: env.APP_BASE_URL,
  frontendBaseUrl: env.FRONTEND_BASE_URL,

  walletProvisioning: {
    cron: env.WALLET_PROVISION_CRON,
    graceSeconds: env.WALLET_PROVISION_GRACE_SECONDS,
    maxBackoffSeconds: env.WALLET_PROVISION_MAX_BACKOFF_SECONDS,
    batchSize: env.WALLET_PROVISION_BATCH_SIZE,
  },

  mail: {
    transport: env.MAIL_TRANSPORT,
    from: env.MAIL_FROM || smtpUser || 'KoboMarket <no-reply@kobomarket.local>',
    smtp: {
      host: smtpHost,
      port: env.SMTP_PORT || env.EMAIL_PORT || 587,
      user: smtpUser,
      pass: smtpPass,
    },
  },

  rateLimit: {
    windowMinutes: env.RATE_LIMIT_WINDOW_MINUTES,
    max: env.RATE_LIMIT_MAX_REQUESTS,
  },

  // Defaults only. The commission rate is overridable by an admin at runtime (stored in PostgreSQL).
  business: {
    commissionRateBps: env.COMMISSION_RATE_BPS,
    escrowAutoCompleteHours: env.ESCROW_AUTO_COMPLETE_HOURS,
    escrowAutoCompleteCron: env.ESCROW_AUTO_COMPLETE_CRON,
    payoutMinimumKobo: env.PAYOUT_MINIMUM_KOBO,
    payoutProcessCron: env.PAYOUT_PROCESS_CRON,
    payoutClaimLeaseSeconds: env.PAYOUT_CLAIM_LEASE_SECONDS,
    payoutBatchSize: env.PAYOUT_BATCH_SIZE,
    orderReconcileCron: env.ORDER_RECONCILE_CRON,
    checkoutStuckSeconds: env.CHECKOUT_STUCK_SECONDS,
  },

  payments: {
    provider: env.PAYMENT_PROVIDER,
    paystackSecretKey: env.PAYSTACK_SECRET_KEY,
    paystackBaseUrl: env.PAYSTACK_BASE_URL,
    mockSecret: env.MOCK_PAYMENT_SECRET,
    fundMinKobo: env.FUND_MIN_KOBO,
    fundMaxKobo: env.FUND_MAX_KOBO,
  },

  idempotency: {
    ttlHours: env.IDEMPOTENCY_TTL_HOURS,
    lockSeconds: env.IDEMPOTENCY_LOCK_SECONDS,
  },
};
