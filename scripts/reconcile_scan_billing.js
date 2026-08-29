#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../src/config/env');
const ScanBilling = require('../src/models/scanBilling.model');
const CreditTransaction = require('../src/models/creditTransaction.model');

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = value && !value.startsWith('--') ? value : true;
    if (value && !value.startsWith('--')) index += 1;
  }
  return args;
}

function dateFilter(field, from, to) {
  const filter = {};
  if (from) filter.$gte = new Date(from);
  if (to) filter.$lte = new Date(to);
  return Object.keys(filter).length ? { [field]: filter } : {};
}

function objectIdFilter(value) {
  if (!value) return {};
  return { businessId: new mongoose.Types.ObjectId(String(value)) };
}

async function main() {
  const args = parseArgs(process.argv);
  const from = args.from || args.start;
  const to = args.to || args.end;
  const businessId = args.businessId || args.business;

  if (!config.mongodb?.uri) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(config.mongodb.uri.replace(/retryWrites=true/gi, 'retryWrites=false'));

  const billingMatch = {
    ...objectIdFilter(businessId),
    ...dateFilter('billedAt', from, to),
  };
  const txMatch = {
    ...objectIdFilter(businessId),
    type: 'SCAN_DEDUCTION',
    'metadata.scanId': { $exists: true, $ne: null },
    ...dateFilter('createdAt', from, to),
  };

  const [billings, transactions, duplicateBillings, duplicateTransactions] = await Promise.all([
    ScanBilling.find(billingMatch).lean(),
    CreditTransaction.find(txMatch).lean(),
    ScanBilling.aggregate([
      { $match: billingMatch },
      { $group: { _id: '$scanId', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ]),
    CreditTransaction.aggregate([
      { $match: txMatch },
      { $group: { _id: '$metadata.scanId', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ]),
  ]);

  const txByScanId = new Map(transactions.map((tx) => [String(tx.metadata?.scanId || ''), tx]));
  const billingByScanId = new Map(billings.map((billing) => [String(billing.scanId), billing]));

  const billedWithoutTransaction = billings
    .filter((billing) => !txByScanId.has(String(billing.scanId)))
    .map((billing) => ({ scanId: billing.scanId, billingId: billing._id, totalScanCharge: billing.totalScanCharge }));

  const transactionWithoutBilling = transactions
    .filter((tx) => !billingByScanId.has(String(tx.metadata?.scanId || '')))
    .map((tx) => ({ scanId: tx.metadata?.scanId, transactionId: tx._id, amount: tx.amount }));

  const amountMismatches = billings
    .map((billing) => {
      const tx = txByScanId.get(String(billing.scanId));
      if (!tx) return null;
      const billingAmount = Number(Number(billing.totalScanCharge || 0).toFixed(2));
      const txAmount = Number(Number(tx.amount || 0).toFixed(2));
      if (billingAmount === txAmount) return null;
      return {
        scanId: billing.scanId,
        billingId: billing._id,
        transactionId: tx._id,
        billingAmount,
        transactionAmount: txAmount,
      };
    })
    .filter(Boolean);

  const report = {
    filters: { from: from || null, to: to || null, businessId: businessId || null },
    totals: {
      billingRows: billings.length,
      scanDeductionTransactions: transactions.length,
      duplicateBillingScanIds: duplicateBillings.length,
      duplicateTransactionScanIds: duplicateTransactions.length,
      billedWithoutTransaction: billedWithoutTransaction.length,
      transactionWithoutBilling: transactionWithoutBilling.length,
      amountMismatches: amountMismatches.length,
    },
    duplicateBillings,
    duplicateTransactions,
    billedWithoutTransaction,
    transactionWithoutBilling,
    amountMismatches,
    note: 'Completed-but-unbilled scans can only be reconciled if completed scan statuses are persisted; current scan sessions are Redis-backed and may expire.',
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[SCAN_BILLING_RECONCILIATION_ERROR]', error?.message || String(error));
  try {
    await mongoose.disconnect();
  } catch (_) {
    // Ignore disconnect failures during error handling.
  }
  process.exit(1);
});
