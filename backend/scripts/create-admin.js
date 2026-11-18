const { connectMongo, disconnectMongo } = require('../src/config/mongo');
const { disconnectPostgres } = require('../src/config/postgres');
const { hashPassword } = require('../src/utils/crypto');
const { registerBody } = require('../src/modules/auth/auth.validation');
const userRepository = require('../src/modules/users/user.repository');
const walletProvisioning = require('../src/modules/wallet/walletProvisioning.service');

async function main() {
  const [argEmail, argPassword, argName] = process.argv.slice(2);
  const email = registerBody.shape.email.parse(argEmail || process.env.ADMIN_EMAIL);

  await connectMongo();

  let user = await userRepository.findByEmail(email);
  if (user) {
    await userRepository.addRole(user.id, 'admin');
    if (!user.emailVerified) await userRepository.markEmailVerified(user.id);
    console.log(`Existing user ${email} is now an admin.`);
  } else {
    const input = registerBody.parse({
      email,
      password: argPassword || process.env.ADMIN_PASSWORD,
      fullName: argName || 'Platform Admin',
    });
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
