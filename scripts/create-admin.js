/**
 * npm run create-admin -- <email> <password> ["Full Name"]
 * (or set ADMIN_EMAIL / ADMIN_PASSWORD in the environment, which keeps the password out of
 * your shell history)
 *
 * Creates a verified admin account, or promotes an existing user to admin, and makes sure
 * its PostgreSQL wallet exists. Needed so that vendor applications can be approved before the
 * full demo seed (`npm run seed`) is available. Safe to run repeatedly.
 *
 * Docker:  docker-compose exec api npm run create-admin -- admin@kobomarket.test 'Str0ngPassw0rd'
 */
const { connectMongo, disconnectMongo } = require('../src/config/mongo');
const { disconnectPostgres } = require('../src/config/postgres');
const { hashPassword } = require('../src/utils/crypto');
const { registerBody } = require('../src/modules/auth/auth.validation');
const userRepository = require('../src/modules/users/user.repository');
const walletProvisioning = require('../src/modules/wallet/walletProvisioning.service');

async function main() {
  const [argEmail, argPassword, argName] = process.argv.slice(2);
  const input = registerBody.parse({
    email: argEmail || process.env.ADMIN_EMAIL,
    password: argPassword || process.env.ADMIN_PASSWORD,
    fullName: argName || 'Platform Admin',
  });

  await connectMongo();

  let user = await userRepository.findByEmail(input.email);
  if (user) {
    await userRepository.addRole(user.id, 'admin');
    if (!user.emailVerified) await userRepository.markEmailVerified(user.id);
    console.log(`Existing user ${input.email} is now an admin.`);
  } else {
    user = await userRepository.create({
      email: input.email,
      passwordHash: await hashPassword(input.password),
      fullName: input.fullName,
      roles: ['buyer', 'admin'],
    });
    await userRepository.markEmailVerified(user.id);
    console.log(`Admin ${input.email} created.`);
  }

  await walletProvisioning.provision(user.id);
  console.log('Wallet ready.');
}

main()
  .catch((err) => {
    console.error(err.issues ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') : err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([disconnectMongo(), disconnectPostgres()]);
  });
