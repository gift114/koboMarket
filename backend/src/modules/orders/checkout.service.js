const { db } = require('../../config/postgres');
const AppError = require('../../utils/AppError');
const bus = require('../../events/bus');
const EVENTS = require('../../events/events');
const { assertNotFrozen } = require('../../utils/guards');
const logger = require('../../utils/logger');
const { DIRECTION, SYSTEM_ACCOUNT, TRANSACTION_TYPE } = require('../../db/constants');
const accountRepository = require('../wallet/account.repository');
const ledgerService = require('../wallet/ledger.service');
const cartService = require('../cart/cart.service');
const productRepository = require('../products/product.repository');
const orderRepository = require('./order.repository');
const commissionService = require('./commission.service');
const { toOrderView } = require('./order.mapper');

const STOCK_FAILURES = ['STOCK_UNAVAILABLE', 'STOCK_ERROR', 'STOCK_INCOMPLETE'];

const stockUnavailable = (problem) =>
  AppError.conflict(
    'An item sold out while you were checking out. You have not been charged.',
    'STOCK_UNAVAILABLE',
    problem ? { productId: problem.productId, name: problem.name } : null,
  );

/** One sub-order per vendor, each with its own items and subtotal. */
function groupByVendor(lines, commissionRateBps) {
  const groups = new Map();
  for (const line of lines) {
    const group = groups.get(line.vendorId) || {
      vendorId: line.vendorId,
      vendorUserId: line.vendorUserId,
      subtotalKobo: 0,
      commissionRateBps,
      items: [],
    };
    group.items.push(line);
    group.subtotalKobo += line.lineTotalKobo;
    groups.set(line.vendorId, group);
  }
  return [...groups.values()];
}

/**
 * Undo a checkout whose stock step failed: put back the stock already taken, then reverse the
 * escrow payment (buyer is refunded) and cancel the order, in one PostgreSQL transaction.
 *
 * Safe to run any number of times and from several places at once (the failing request AND the
 * recovery job): the order row is locked and only a PAID order is cancelled, the ledger
 * reversal is idempotent and one-shot, and each item's restock is claimed in PostgreSQL BEFORE
 * MongoDB is touched, so a crash can lose a unit of stock but can never invent one.
 */
async function compensate(orderId, reason) {
  // Only an order that is paid but whose stock step never completed may be compensated. Check
  // BEFORE touching stock: a healthy order (reserved, or already shipped) must never be
  // restocked or refunded, whoever asks.
  const order = await orderRepository.findById(orderId);
  const compensable = (o) => o && o.status === 'PAID' && o.stockStatus === 'PENDING' && o.subOrders.every((s) => s.status === 'PAID');
  if (!compensable(order)) return;

  for (const sub of order.subOrders) {
    for (const item of sub.items) {
      if (!(await orderRepository.claimItemRestore(item.id))) continue;
      try {
        await productRepository.restoreStock(item.productId, item.variantId, item.quantity);
      } catch (err) {
        logger.error({ err, orderId, itemId: item.id }, 'Could not restore stock during compensation');
      }
    }
  }

  await db.transaction(async (trx) => {
    const locked = await orderRepository.lockOrder(trx, orderId);
    if (!locked || locked.status !== 'PAID' || locked.stockStatus !== 'PENDING') return; // done by someone else meanwhile
    await ledgerService.reverseTransaction({
      transactionId: locked.paymentTransactionId,
      reason: `Checkout failed: ${reason}`,
      idempotencyKey: `order-compensate:${orderId}`,
      trx,
    });
    await orderRepository.markCancelled(trx, orderId, reason);
  });
  logger.warn({ orderId, reason }, 'Checkout compensated: stock restored, escrow refunded, order cancelled');
}

/** Take the stock of every item. Returns the first item that could not be taken, or null. */
async function takeStock(order) {
  for (const sub of order.subOrders) {
    for (const item of sub.items) {
      const taken = await productRepository.decrementStock(item.productId, item.variantId, item.quantity);
      if (!taken) return item;
      await orderRepository.flagItemDecremented(item.id);
    }
  }
  return null;
}

/**
 * Checkout, in the order the brief prescribes:
 *
 *   1. validate the cart against MongoDB: stock and CURRENT prices (cartService.prepareCheckout);
 *   2. ONE PostgreSQL transaction: create the order (1 parent + 1 sub-order per vendor) and its
 *      items, lock the buyer's wallet and PLATFORM_ESCROW (sorted, FOR UPDATE), check the
 *      balance, move buyer -> escrow through the ledger, mark everything PAID. Any failure
 *      (e.g. insufficient funds) rolls the whole thing back: no order, no money moved;
 *   3. decrement stock in MongoDB, atomically per item. If that fails, COMPENSATE (above);
 *   4. remove the bought lines from the cart.
 *
 * Cross-database consistency, case 2 of 2 ("escrow done but the MongoDB stock decrement
 * failed"). If the process dies between steps 2 and 3 the order is PAID with stock_status
 * PENDING, and the recovery job (reconcileStuckOrders) compensates it after a timeout.
 *
 * "The same Idempotency-Key never creates two orders" is enforced twice: by the middleware
 * (replays the stored response) and by UNIQUE (buyer_id, idempotency_key) on orders, which
 * also covers a request taken over after a crash.
 */
async function checkout(user, { idempotencyKey, expectedTotalKobo }) {
  assertNotFrozen(user); // a frozen account places no new orders
  const existing = await orderRepository.findByBuyerAndKey(user.id, idempotencyKey);
  if (existing) return resultForExisting(existing);

  const prepared = await cartService.prepareCheckout(user.id);
  if (expectedTotalKobo !== undefined && expectedTotalKobo !== prepared.totalKobo) {
    throw AppError.conflict('The prices in your cart have changed', 'PRICE_CHANGED', {
      expectedTotalKobo,
      currentTotalKobo: prepared.totalKobo,
      priceChanges: prepared.priceChanges,
    });
  }

  const commissionRateBps = await commissionService.getRateBps();
  const subOrders = groupByVendor(prepared.lines, commissionRateBps);

  let orderId;
  try {
    orderId = await db.transaction(async (trx) => {
      const buyerAccount = await accountRepository.createUserAccountIfMissing(user.id, trx);
      const escrowId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.ESCROW, trx);

      const created = await orderRepository.createOrderRows(trx, {
        buyerId: user.id,
        idempotencyKey,
        totalKobo: prepared.totalKobo,
        subOrders,
      });

      // Locks escrow and the buyer's wallet (sorted by id, FOR UPDATE), checks the balance, posts.
      const { transaction } = await ledgerService.postTransaction({
        trx,
        type: TRANSACTION_TYPE.ORDER_PAYMENT,
        idempotencyKey: `order:${created.orderId}`,
        reference: `ORDER-${created.orderId}`,
        entries: [
          { accountId: buyerAccount.id, direction: DIRECTION.DEBIT, amountKobo: prepared.totalKobo },
          { accountId: escrowId, direction: DIRECTION.CREDIT, amountKobo: prepared.totalKobo },
        ],
        metadata: { description: 'Order payment into escrow', orderId: created.orderId },
      });

      await orderRepository.markPaid(trx, created.orderId, transaction.id);
      return created.orderId;
    });
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'orders_buyer_key_unique') {
      return resultForExisting(await orderRepository.findByBuyerAndKey(user.id, idempotencyKey)); // lost a race with the same key
    }
    throw err;
  }

  const order = await orderRepository.findById(orderId);

  let problem;
  try {
    problem = await takeStock(order);
  } catch (err) {
    logger.error({ err, orderId }, 'Stock decrement failed unexpectedly, compensating');
    await compensateOrFlag(orderId, 'STOCK_ERROR');
    throw new AppError(503, 'STOCK_SERVICE_UNAVAILABLE', 'We could not reserve your items. You have not been charged, please try again.');
  }
  if (problem) {
    await compensateOrFlag(orderId, 'STOCK_UNAVAILABLE');
    throw stockUnavailable(problem);
  }

  if (!(await orderRepository.markStockReserved(orderId))) {
    // The recovery job cancelled this order while we were still working on it.
    await compensateOrFlag(orderId, 'STOCK_UNAVAILABLE');
    throw stockUnavailable(null);
  }

  await cartService
    .removeItems(user.id, prepared.lines.map((l) => l.itemId))
    .catch((err) => logger.error({ err, orderId }, 'Order placed but the cart could not be cleaned'));

  const placed = await orderRepository.findById(orderId);
  bus.publish(EVENTS.ORDER_PLACED, {
    orderId,
    buyerId: user.id,
    totalKobo: placed.totalKobo,
    subOrders: placed.subOrders.map((s) => ({ id: s.id, vendorUserId: s.vendorUserId, subtotalKobo: s.subtotalKobo })),
  });
  return toOrderView(placed);
}

/** Run compensation; if even that fails, the recovery job will retry it, so just log. */
async function compensateOrFlag(orderId, reason) {
  try {
    await compensate(orderId, reason);
  } catch (err) {
    logger.error({ err, orderId, reason }, 'Compensation failed: the recovery job will retry it');
  }
}

/** Same key as an earlier checkout: return that order, or repeat that order's failure. */
async function resultForExisting(order) {
  if (order.status === 'CANCELLED' && STOCK_FAILURES.includes(order.cancelReason)) {
    throw stockUnavailable(null);
  }
  return toOrderView(await orderRepository.findById(order.id));
}

/** Recovery job: cancel and refund orders that were paid but never got their stock. */
async function reconcileStuckOrders(thresholdSeconds) {
  const stuck = await orderRepository.findStuckOrders(thresholdSeconds);
  let recovered = 0;
  for (const order of stuck) {
    try {
      await compensate(order.id, 'STOCK_INCOMPLETE');
      recovered += 1;
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'Could not recover a stuck order, will retry');
    }
  }
  return { found: stuck.length, recovered };
}

module.exports = { checkout, compensate, reconcileStuckOrders };
