#!/usr/bin/env node
/**
 * Puts Rate 2's Tax box at 0 for shops still carrying the old default of 3.
 *
 * Until 28 Sep 2026 the Tax box started at 3, and every shop that opened Gold
 * Rate Settings had that 3 written to its record whether or not it wanted
 * it. The default is 0 now, but a saved number is what a shop chose, so
 * those records still read 3 and Rate 2 still comes out 3% under the board
 * figure.
 *
 *   node scripts/reset_rtgs_tax.js                  # dry run: lists what it would change
 *   node scripts/reset_rtgs_tax.js --apply          # sets rtgsTaxPercent 3 -> 0
 *   node scripts/reset_rtgs_tax.js --apply --from 3 --to 0
 *
 * Only records at exactly --from (3) are touched: a shop that typed 2 or 5
 * chose it and keeps it. The gold-rates cache of each shop changed is
 * invalidated, so the app shows the new figure on its next read.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../src/config/env');
const GoldTaxSetting = require('../src/models/goldTaxSetting.model');

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

/**
 * @param {object} options
 * @param {number} options.from    The saved percent to replace (default 3).
 * @param {number} options.to      What it becomes (default 0).
 * @param {boolean} options.apply  Write. Without it nothing is saved.
 */
async function resetRtgsTax({ from = 3, to = 0, apply = false } = {}) {
  const records = await GoldTaxSetting.find({ rtgsTaxPercent: from }).lean();
  const summary = { matched: records.length, changed: 0, cacheCleared: 0 };

  for (const record of records) {
    const businessId = String(record.businessId);
    const who = record.userId ? `employee ${record.userId}` : 'owner';
    console.log(`${apply ? 'set ' : 'would'}  ${businessId}  ${who}  rtgsTaxPercent ${from} -> ${to}`);
    if (!apply) continue;

    await GoldTaxSetting.updateOne({ _id: record._id, rtgsTaxPercent: from }, { $set: { rtgsTaxPercent: to } });
    summary.changed += 1;
  }

  if (apply && summary.changed > 0) {
    // Best effort: the cache also refreshes on its own with the next feed
    // move, so a Redis that cannot be reached from here is not a failure.
    try {
      // Required here, not at the top, so a dry run never opens Redis.
      const redisService = require('../src/services/redis.service');
      const businessIds = [...new Set(records.map((record) => String(record.businessId)))];
      for (const businessId of businessIds) {
        await redisService.invalidateGoldRatesCache(businessId);
        summary.cacheCleared += 1;
      }
    } catch (error) {
      console.warn('cache not cleared (it refreshes with the next feed move):', error.message || error);
    }
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  const apply = Boolean(args.apply);
  const from = Number(args.from ?? 3);
  const to = Number(args.to ?? 0);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < 0 || to > 100) {
    throw new Error('--from and --to must be percents between 0 and 100');
  }

  if (!config.mongodb?.uri) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(config.mongodb.uri.replace(/retryWrites=true/gi, 'retryWrites=false'));
  console.log(`${apply ? 'APPLYING' : 'DRY RUN (nothing is written; pass --apply)'}`);
  console.log(`Rate 2 Tax box: ${from} -> ${to}\n`);

  try {
    const summary = await resetRtgsTax({ from, to, apply });
    console.log('\n--- summary');
    console.log(`records at ${from}    ${summary.matched}`);
    console.log(`changed         ${summary.changed}`);
    console.log(`cache cleared   ${summary.cacheCleared}`);
    return summary;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = { resetRtgsTax, parseArgs };
