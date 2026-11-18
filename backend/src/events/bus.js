const { EventEmitter } = require('events');
const logger = require('../utils/logger');

/**
 * A tiny in-process event bus. Business code calls publish() AFTER its database transaction has
 * committed; listeners run later (next tick), each in its own try/catch. So a slow or broken
 * listener can never slow down, fail or roll back the request that caused the event, and a
 * notification is never sent for something that was rolled back.
 *
 * Delivery is at-most-once and in-process: if the process dies between the commit and the
 * listener, that notification is lost (noted in the README); the money and the orders are not.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);
const inFlight = new Set();

function track(promise) {
  inFlight.add(promise);
  promise.finally(() => inFlight.delete(promise)).catch(() => {});
  return promise;
}

/** Register a listener. Errors it throws are logged, never propagated. */
function on(event, handler) {
  emitter.on(event, (payload) => {
    track(
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err) => logger.error({ err: err.message, event }, 'Event listener failed')),
    );
  });
}

/** Fire and forget. Never throws and never waits for listeners. */
function publish(event, payload) {
  track(
    new Promise((resolve) => {
      setImmediate(() => {
        try {
          emitter.emit(event, payload);
        } catch (err) {
          logger.error({ err: err.message, event }, 'Event publish failed');
        }
        resolve();
      });
    }),
  );
}

/** Resolves when every published event has been fully handled (for tests and graceful shutdown). */
async function idle() {
  while (inFlight.size > 0) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.allSettled([...inFlight]);
  }
}

function removeAllListeners() {
  emitter.removeAllListeners();
}

module.exports = { on, publish, idle, removeAllListeners };
