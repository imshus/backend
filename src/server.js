const os = require('os');
const app = require('./app');
const config = require('./config/env');
const connectDB = require('./config/db');
const { initMcxScheduler } = require('./services/mcxScheduler.service');
const DiamondRate = require('./models/diamondRate.model');
const PaymentTransaction = require('./models/paymentTransaction.model');

const PORT = config.port || 3000;
const HOST = '0.0.0.0';

async function dropObsoleteBusinessUserEmailIndex() {
  try {
    const collection = require('mongoose').connection.db.collection('business_users');
    const indexes = await collection.indexes();
    const emailIndex = indexes.find((idx) => idx?.name === 'email_1' || (idx?.key && idx.key.email === 1));

    if (!emailIndex) {
      return;
    }

    await collection.dropIndex(emailIndex.name);
    console.log(`[DB] Dropped obsolete index business_users.${emailIndex.name}`);
  } catch (error) {
    if (error?.codeName === 'IndexNotFound' || error?.code === 27) {
      return;
    }
    console.warn('[DB] Failed to drop obsolete business_users email index:', error.message);
  }
}

async function reconcilePaymentTransactionIndexes() {
  try {
    const collection = require('mongoose').connection.db.collection('payment_transactions');
    const indexes = await collection.indexes();
    const paymentIdIdx = indexes.find((idx) => idx?.name === 'paymentId_1');

    const requiresRecreate = Boolean(
      paymentIdIdx &&
      (!paymentIdIdx.partialFilterExpression || !paymentIdIdx.unique),
    );

    if (requiresRecreate) {
      await collection.dropIndex('paymentId_1');
      console.log('[DB] Dropped legacy index payment_transactions.paymentId_1');
    }

    await PaymentTransaction.syncIndexes();
    console.log('[DB] PaymentTransaction indexes synced');
  } catch (error) {
    if (error?.codeName === 'IndexNotFound' || error?.code === 27) {
      await PaymentTransaction.syncIndexes();
      console.log('[DB] PaymentTransaction indexes synced');
      return;
    }
    console.warn('[DB] Failed to reconcile PaymentTransaction indexes:', error.message);
  }
}

function getLanAddresses() {
  const addresses = new Set(['127.0.0.1', 'localhost']);
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.add(entry.address);
      }
    }
  }

  return [...addresses];
}

connectDB().then(async () => {
  try {
    await dropObsoleteBusinessUserEmailIndex();
    await DiamondRate.syncIndexes();
    console.log('[DB] DiamondRate indexes synced');
    await reconcilePaymentTransactionIndexes();
  } catch (error) {
    console.warn('[DB] Failed to sync startup indexes:', error.message);
  }

  // Initialize the background polling scheduler for MCX rates
  await initMcxScheduler();

  app.listen(PORT, HOST, () => {
    console.log(`Server is running on port ${PORT} in ${config.env} mode`);
    console.log('API URLs for Expo / phone testing:');
    for (const address of getLanAddresses()) {
      console.log(`  http://${address}:${PORT}/api/v1/health`);
    }
    if (config.env === 'development') {
      console.log('Dev OTPs print here after contact-details submit.');
    }
  });
});
