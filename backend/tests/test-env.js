// Tests always run against a dedicated database so they can never touch development data.
module.exports = {
  testDatabaseUrl:
    process.env.TEST_DATABASE_URL || 'postgres://kobo:kobo_password@localhost:5432/kobomarket_test',
};
