// Test environment: no real databases are needed for Day 1 tests.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/kobomarket_test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://kobo:kobo_password@localhost:5432/kobomarket_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-1234';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-1234';
