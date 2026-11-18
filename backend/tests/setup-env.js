const { testDatabaseUrl } = require('./test-env');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/kobomarket_test';
// Always the test database, even if a .env points DATABASE_URL somewhere else.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-1234';
process.env.MAIL_TRANSPORT = 'memory';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.BCRYPT_ROUNDS = '4'; // minimum cost, keeps the suite fast
