const request = require('supertest');
const { db } = require('../../src/config/postgres');
const accountRepository = require('../../src/modules/wallet/account.repository');
const ledgerService = require('../../src/modules/wallet/ledger.service');
const { SYSTEM_ACCOUNT, TRANSACTION_TYPE } = require('../../src/db/constants');
const { bearer } = require('./users');

let keySeq = 0;
const newKey = () => `order-key-${Date.now()}-${(keySeq += 1)}`;

/** Put `kobo` into the user's wallet through the real ledger service (funded from "the bank"). */
async function fundWallet(userId, kobo) {
  const account = await accountRepository.createUserAccountIfMissing(userId);
  const external = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
  await ledgerService.transfer({ fromAccountId: external, toAccountId: account.id, amountKobo: kobo, type: TRANSACTION_TYPE.WALLET_FUNDING });
  return account;
}

const walletBalance = async (userId) => {
  const row = await db('accounts').where({ owner_type: 'USER', owner_id: userId }).first();
  return row ? row.balance_kobo : 0;
};
const escrowBalance = async () => (await db('accounts').where({ owner_type: 'SYSTEM', owner_id: 'PLATFORM_ESCROW' }).first()).balance_kobo;
const countOrders = async (buyerId) => Number((await db('orders').where({ buyer_id: buyerId }).count('* as n').first()).n);

const addToCart = (app, user, body) => request(app).post('/api/v1/cart/items').set(bearer(user.token)).send(body);
const checkout = (app, user, { key = newKey(), body = {} } = {}) =>
  request(app).post('/api/v1/orders/checkout').set(bearer(user.token)).set('Idempotency-Key', key).send(body);
const productStock = async (app, product) => (await request(app).get(`/api/v1/products/${product.slug}`)).body.data.product.stock;

module.exports = { newKey, fundWallet, walletBalance, escrowBalance, countOrders, addToCart, checkout, productStock };
