const knex = require('knex');
const { testDatabaseUrl } = require('./test-env');
const { runAudit } = require('../src/modules/audit/ledgerAudit.service');

/**
 * After the whole suite: audit the ledger left behind by every test. Tests that tamper on
 * purpose do so inside rolled-back transactions, so the data left here must be clean.
 */
module.exports = async () => {
  const db = knex({ client: 'pg', connection: testDatabaseUrl });
  try {
    const result = await runAudit(db);
    // eslint-disable-next-line no-console
    console.log(`\nLedger audit after the test run: ${result.pass ? 'PASS' : 'FAIL'}`);
    if (!result.pass) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result.checks.filter((c) => !c.pass), null, 2));
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
};
