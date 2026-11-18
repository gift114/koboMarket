const walletProvisioning = require('../modules/wallet/walletProvisioning.service');

// Thin wrapper so every background job has the same shape: run(now) -> summary.
module.exports = {
  name: 'wallet-provisioning',
  run: (now = new Date()) => walletProvisioning.reconcile(now),
};
