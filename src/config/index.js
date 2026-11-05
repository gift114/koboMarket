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
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
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
  PAYOUT_MINIMUM_KOBO: int(100000),

  PAYMENT_PROVIDER: z.enum(['mock', 'paystack']).default('mock'),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_BASE_URL: z.string().default('https://api.paystack.co'),
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

if (env.PAYMENT_PROVIDER === 'paystack' && !env.PAYSTACK_SECRET_KEY) {
  // eslint-disable-next-line no-console
  console.error('PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack');
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
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtlMinutes: env.ACCESS_TOKEN_TTL_MINUTES,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    emailVerificationTtlHours: env.EMAIL_VERIFICATION_TTL_HOURS,
    passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    loginMaxFailedAttempts: env.LOGIN_MAX_FAILED_ATTEMPTS,
    loginWindowMinutes: env.LOGIN_WINDOW_MINUTES,
  },

  rateLimit: {
    windowMinutes: env.RATE_LIMIT_WINDOW_MINUTES,
    max: env.RATE_LIMIT_MAX_REQUESTS,
  },

  // Defaults only. The commission rate is overridable by an admin at runtime (stored in PostgreSQL).
  business: {
    commissionRateBps: env.COMMISSION_RATE_BPS,
    escrowAutoCompleteHours: env.ESCROW_AUTO_COMPLETE_HOURS,
    payoutMinimumKobo: env.PAYOUT_MINIMUM_KOBO,
  },

  payments: {
    provider: env.PAYMENT_PROVIDER,
    paystackSecretKey: env.PAYSTACK_SECRET_KEY,
    paystackBaseUrl: env.PAYSTACK_BASE_URL,
  },
};
