/**
 * npm run audit:ledger
 */
require('dotenv').config();
const { runAudit } = require('../src/modules/audit/ledgerAudit.service');
const { disconnectPostgres } = require('../src/config/postgres');
const { formatNaira } = require('../src/utils/money');

(async () => {
  let exitCode = 1;
  try {
    const result = await runAudit();
    /* eslint-disable no-console */
    console.log('\nKoboMarket ledger audit');
    console.log('-----------------------');
    for (const c of result.checks) {
      console.log(`${c.pass ? '  ok  ' : ' FAIL '} ${c.name}`);
      if (!c.pass) console.log(JSON.stringify(c.failures.slice(0, 10), null, 2));
    }
    const t = result.totals;
    console.log(`\nAccounts: ${t.accounts}   Transactions: ${t.transactions}   Entries: ${t.entries}`);
    console.log(`Funded: ${formatNaira(t.fundedKobo)}   Paid out: ${formatNaira(t.paidOutKobo)}   Held: ${formatNaira(t.heldKobo)}`);
    console.log(`\n${result.pass ? 'PASS' : 'FAIL'}\n`);
    exitCode = result.pass ? 0 : 1;
  } catch (err) {
    console.error('Audit could not run:', err.message);
  } finally {
    await disconnectPostgres().catch(() => {});
  }
  process.exit(exitCode);
})();
