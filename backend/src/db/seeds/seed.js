const { randomBytes } = require('crypto');
const { hashPassword } = require('../../utils/crypto');
const bus = require('../../events/bus');
const { registerListeners } = require('../../modules/notifications/notification.listeners');
const userRepository = require('../../modules/users/user.repository');
const vendorRepository = require('../../modules/vendors/vendor.repository');
const vendorsService = require('../../modules/vendors/vendors.service');
const productsService = require('../../modules/products/products.service');
const cartService = require('../../modules/cart/cart.service');
const checkoutService = require('../../modules/orders/checkout.service');
const fulfilmentService = require('../../modules/orders/fulfilment.service');
const disputesService = require('../../modules/disputes/disputes.service');
const orderRepository = require('../../modules/orders/order.repository');
const walletProvisioning = require('../../modules/wallet/walletProvisioning.service');
const accountRepository = require('../../modules/wallet/account.repository');
const ledgerService = require('../../modules/wallet/ledger.service');
const { SYSTEM_ACCOUNT, TRANSACTION_TYPE } = require('../../db/constants');

/**
 * Demo data: 1 admin, 3 vendors, 20 products, 5 buyers with funded wallets, and four orders in
 * different states (PAID, SHIPPED, COMPLETED, DISPUTED) so every screen has something to show.
 *
 * Everything goes through the real services (so every rule and the ledger apply), and it is safe
 * to run again: accounts are found by email, products by name, wallets are funded with idempotency
 * keys, and each demo order has a fixed idempotency key.
 */

const BUYER_FUNDING_KOBO = 50_000_000; // N500,000 each

const CATALOG = [
  // [name, category, priceKobo, stock]
  ['Ankara Print Shirt', 'fashion', 1_800_000, 40],
  ['Leather Sandals', 'fashion', 2_500_000, 25],
  ['Adire Wrapper', 'fashion', 3_200_000, 15],
  ['Beaded Necklace', 'accessories', 650_000, 60],
  ['Straw Hat', 'accessories', 450_000, 30],
  ['Wireless Earbuds', 'electronics', 3_500_000, 35],
  ['Power Bank 20000mAh', 'electronics', 2_800_000, 50],
  ['Phone Stand', 'electronics', 350_000, 80],
  ['Smart Watch', 'electronics', 6_500_000, 12],
  ['Bluetooth Speaker', 'electronics', 4_200_000, 18],
  ['Shea Butter 500g', 'beauty', 850_000, 70],
  ['Black Soap Pack', 'beauty', 400_000, 90],
  ['Hair Growth Oil', 'beauty', 1_200_000, 45],
  ['Jollof Spice Mix', 'food', 300_000, 100],
  ['Palm Oil 5L', 'food', 1_650_000, 30],
  ['Dried Hibiscus 250g', 'food', 500_000, 55],
  ['Handwoven Basket', 'home', 1_400_000, 22],
  ['Scented Candle Set', 'home', 950_000, 40],
  ['Clay Water Pot', 'home', 1_100_000, 20],
  ['Notebook Bundle (3)', 'stationery', 600_000, 75],
];

const VENDORS = [
  { email: 'vendor1@kobomarket.test', fullName: 'Ada Okafor', storeName: 'Ada Fashion House', bank: ['GTBank', '0123456789', 'Ada Okafor'] },
  { email: 'vendor2@kobomarket.test', fullName: 'Tunde Bello', storeName: 'Tunde Tech Hub', bank: ['Access Bank', '0234567891', 'Tunde Bello'] },
  { email: 'vendor3@kobomarket.test', fullName: 'Ngozi Eze', storeName: 'Ngozi Naturals', bank: ['Zenith Bank', '0345678912', 'Ngozi Eze'] },
];

const BUYERS = ['Chidi Obi', 'Amina Yusuf', 'Seun Adeyemi', 'Funke Balogun', 'Ibrahim Musa'].map((fullName, i) => ({
  email: `buyer${i + 1}@kobomarket.test`,
  fullName,
}));

async function ensureUser({ email, fullName, roles }, passwordHash, created) {
  let user = await userRepository.findByEmail(email);
  if (!user) {
    user = await userRepository.create({ email, passwordHash, fullName, roles });
    created.push(email);
  }
  for (const role of roles) if (!user.roles.includes(role)) await userRepository.addRole(user.id, role);
  if (!user.emailVerified) await userRepository.markEmailVerified(user.id);
  await walletProvisioning.provision(user.id);
  return { ...(await userRepository.findById(user.id)) };
}

async function ensureVendor(user, spec) {
  let vendor = await vendorRepository.findByUserId(user.id);
  if (!vendor) {
    const applied = await vendorsService.apply(user.id, {
      storeName: spec.storeName,
      description: `${spec.storeName}: demo store`,
      bankDetails: { bankName: spec.bank[0], accountNumber: spec.bank[1], accountName: spec.bank[2] },
    });
    vendor = applied.vendor || applied;
  }
  return vendor;
}

async function fund(user) {
  const account = await accountRepository.createUserAccountIfMissing(user.id);
  const externalId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
  const { replayed } = await ledgerService.transfer({
    fromAccountId: externalId,
    toAccountId: account.id,
    amountKobo: BUYER_FUNDING_KOBO,
    type: TRANSACTION_TYPE.WALLET_FUNDING,
    idempotencyKey: `seed:fund:${user.id}`,
    reference: `SEED-FUND-${user.id}`,
    metadata: { description: 'Seed: demo wallet funding' },
  });
  return !replayed;
}

/** Place a demo order once (fixed idempotency key) and return its first sub-order. */
async function placeOrder(buyer, key, productId, quantity = 1) {
  let order = await orderRepository.findByBuyerAndKey(buyer.id, key);
  if (!order) {
    await cartService.addItem(buyer, { productId, quantity });
    await checkoutService.checkout(buyer, { idempotencyKey: key });
    order = await orderRepository.findByBuyerAndKey(buyer.id, key);
  }
  return (await orderRepository.findById(order.id)).subOrders[0];
}

const statusOf = async (subId) => (await orderRepository.findSubOrder(subId)).status;

/**
 * @param {{password?: string, log?: (msg: string) => void}} [options]
 */
async function run({ password, log = () => {} } = {}) {
  const generated = !password;
  const pw = password || `${randomBytes(9).toString('base64url')}#9a`;
  const passwordHash = await hashPassword(pw);
  registerListeners();
  const createdEmails = [];
  const summary = { users: 0, vendors: 0, products: 0, productsCreated: 0, fundedWallets: 0, orders: {}, passwordSetForNewUsers: generated ? pw : null, createdEmails };

  const admin = await ensureUser({ email: 'admin@kobomarket.test', fullName: 'Platform Admin', roles: ['buyer', 'admin'] }, passwordHash, createdEmails);
  log('admin ready');

  const vendors = [];
  for (const spec of VENDORS) {
    const user = await ensureUser({ email: spec.email, fullName: spec.fullName, roles: ['buyer'] }, passwordHash, createdEmails);
    const vendor = await ensureVendor(user, spec);
    if (vendor.status !== 'approved') await vendorsService.approve(admin.id, vendor.id);
    vendors.push({ user: await userRepository.findById(user.id), vendor: await vendorRepository.findByUserId(user.id) });
  }
  log(`${vendors.length} vendors approved`);

  // 20 products, spread over the vendors, created only if the vendor does not have one of that name yet
  const productIds = [];
  for (const [i, [name, category, priceKobo, stock]] of CATALOG.entries()) {
    const { user, vendor } = vendors[i % vendors.length];
    const existing = await productsService.list({ vendor: vendor.id, limit: 50, sort: 'newest' });
    const found = existing.products.find((p) => p.name === name);
    if (found) {
      productIds.push(found.id);
    } else {
      const created = await productsService.create(user.id, { name, category, priceKobo, stock, description: `${name}: demo product`, images: [], tags: [category], variants: [], isActive: true });
      productIds.push((created.product || created).id);
      summary.productsCreated += 1;
    }
  }
  summary.products = productIds.length;
  log(`${productIds.length} products`);

  const buyers = [];
  for (const spec of BUYERS) {
    const user = await ensureUser({ ...spec, roles: ['buyer'] }, passwordHash, createdEmails);
    if (await fund(user)) summary.fundedWallets += 1;
    buyers.push(user);
  }
  log(`${buyers.length} buyers funded`);

  // Four orders in four different states.
  const by = (vendorIndex) => productIds.filter((_, i) => i % vendors.length === vendorIndex);
  const v1 = vendors[0].user;
  const v2 = vendors[1].user;
  const v3 = vendors[2].user;

  const paid = await placeOrder(buyers[0], 'seed-order-1', by(0)[0], 2);
  summary.orders.paid = paid.id;

  const shipped = await placeOrder(buyers[1], 'seed-order-2', by(1)[0], 1);
  if ((await statusOf(shipped.id)) === 'PAID') await fulfilmentService.ship(v2, shipped.id);
  summary.orders.shipped = shipped.id;

  const completed = await placeOrder(buyers[2], 'seed-order-3', by(0)[1], 1);
  if ((await statusOf(completed.id)) === 'PAID') await fulfilmentService.ship(v1, completed.id);
  if ((await statusOf(completed.id)) === 'SHIPPED') await fulfilmentService.confirmDelivery(buyers[2], completed.id);
  summary.orders.completed = completed.id;

  const disputed = await placeOrder(buyers[3], 'seed-order-4', by(2)[0], 1);
  if ((await statusOf(disputed.id)) === 'PAID') await fulfilmentService.ship(v3, disputed.id);
  if ((await statusOf(disputed.id)) === 'SHIPPED') {
    await disputesService.open(buyers[3], disputed.id, { reason: 'The item arrived damaged and the box was open.', evidence: [{ type: 'text', value: 'Photos available on request' }] });
  }
  summary.orders.disputed = disputed.id;
  log('4 demo orders (PAID, SHIPPED, COMPLETED, DISPUTED)');

  await bus.idle(); // let the notifications for those orders be written
  summary.users = 1 + vendors.length + buyers.length;
  summary.vendors = vendors.length;
  return summary;
}

module.exports = { run, CATALOG, VENDORS, BUYERS, BUYER_FUNDING_KOBO };
