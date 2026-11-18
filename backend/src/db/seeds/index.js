/**
 * npm run seed        (after `npm run migrate`)
 *
 * Creates the demo data described in seed.js. Safe to run repeatedly. Refuses to run in
 * production. Set SEED_PASSWORD to choose the password of the demo accounts; otherwise a random
 * one is generated and printed once (accounts that already exist keep their password).
 */
const config = require('../../config');
const { connectMongo, disconnectMongo } = require('../../config/mongo');
const { db } = require('../../config/postgres');
const { run } = require('./seed');

async function main() {
  if (config.isProd) {
    console.error('Refusing to seed demo data in production.');
    process.exit(1);
  }
  const { rows } = await db.raw("SELECT to_regclass('public.disputes') AS t");
  if (!rows[0].t) {
    console.error('The database is not migrated. Run "npm run migrate" first.');
    process.exit(1);
  }

  await connectMongo();
  const summary = await run({ password: process.env.SEED_PASSWORD || undefined, log: (m) => console.log(`  ${m}`) });

  console.log('\nSeed complete.');
  console.log(`  users: ${summary.users}   vendors: ${summary.vendors}   products: ${summary.products} (${summary.productsCreated} new)   wallets funded now: ${summary.fundedWallets}`);
  console.log('  accounts: admin@kobomarket.test, vendor1..3@kobomarket.test, buyer1..5@kobomarket.test');
  if (summary.passwordSetForNewUsers && summary.createdEmails.length > 0) {
    console.log(`  password for the ${summary.createdEmails.length} accounts created now: ${summary.passwordSetForNewUsers}`);
  } else if (summary.createdEmails.length === 0) {
    console.log('  all accounts already existed; their passwords are unchanged.');
  } else {
    console.log('  password: the value of SEED_PASSWORD');
  }
  await disconnectMongo();
  await db.destroy();
}

main().catch(async (err) => {
  console.error('Seed failed:', err.message);
  await db.destroy().catch(() => {});
  process.exit(1);
});
