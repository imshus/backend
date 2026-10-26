#!/usr/bin/env node
/**
 * Fills the App Store review shop with sample masters, so Apple's reviewer
 * sees a working shop: labour codes, wastage codes and item codes the sample
 * tags use. The shop itself is made the normal way first — the owner signs
 * up in the app with the review number (REVIEW_LOGIN_PHONE, whose code is
 * REVIEW_LOGIN_OTP) — and this only adds what is missing; nothing the shop
 * already has is changed.
 *
 *   node scripts/seed_review_demo.js --phone 9XXXXXXXXX            # dry run: lists what it would add
 *   node scripts/seed_review_demo.js --phone 9XXXXXXXXX --apply    # adds it
 *
 * For scan credits, put the shop on a licence with scripts/grant_license.js.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../src/config/env');
const BusinessUser = require('../src/models/businessUser.model');
const Business = require('../src/models/business.model');
const WastageCode = require('../src/models/wastageCode.model');
const LabourCode = require('../src/models/labourCode.model');
const ItemCode = require('../src/models/itemCode.model');

/** The design mockup's codes, so the reviewer sees what the screens show. */
const SAMPLE_WASTAGE = [
  { code: 'WS-05', percent: 5 },
  { code: 'WS-08', percent: 8 },
  { code: 'WS-10', percent: 10 },
  { code: 'WS-12', percent: 12 },
];

const SAMPLE_LABOUR = [
  { code: 'LB-01', rate: 350, unit: 'Per Gram' },
  { code: 'LB-02', rate: 380, unit: 'Per Gram' },
  { code: 'LB-03', rate: 415, unit: 'Per Gram' },
  { code: 'LB-04', rate: 450, unit: 'Per Gram' },
  { code: 'LB-05', rate: 600, unit: 'Per Gram' },
  { code: 'LB-06', rate: 200, unit: 'Per Gram' },
];

/** Item prefixes on the sample tags (ST NO GR10286, LR10980). */
const SAMPLE_ITEMS = [
  { code: 'GR', description: 'Gold Ring', wastage: 8, labour: 415, labourUnit: 'Per Gram' },
  { code: 'LR', description: 'Ladies Ring', wastage: 10, labour: 450, labourUnit: 'Per Gram' },
];

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

const tenDigits = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

/** Adds the rows of `samples` the shop does not have yet (by code); returns the codes added (or due). */
async function addMissing(Model, businessId, samples, apply) {
  const existing = await Model.find({ businessId, userId: null }).select('code').lean();
  const have = new Set(existing.map((row) => String(row.code).toUpperCase()));
  const missing = samples.filter((row) => !have.has(row.code.toUpperCase()));
  if (apply && missing.length) {
    await Model.insertMany(missing.map((row) => ({ ...row, businessId, userId: null })), { ordered: false });
  }
  return missing.map((row) => row.code);
}

/**
 * @param {object} options
 * @param {string} options.phone  The review shop owner's sign-in number.
 * @param {boolean} options.apply Write. Without it nothing is saved.
 */
async function seedReviewDemo({ phone, apply = false }) {
  const normalized = tenDigits(phone);
  if (normalized.length !== 10) {
    throw new Error('--phone must be the 10-digit number the review shop owner signs in with');
  }
  const owner = await BusinessUser.findOne({ phone: normalized, role: 'OWNER' }).sort({ createdAt: 1 }).lean();
  if (!owner) {
    throw new Error(`No owner account signs in with ${normalized}: sign up in the app with it first`);
  }
  const business = await Business.findById(owner.businessId).lean();
  console.log(`shop        ${business?.tradeName || business?.legalName || '(no name)'}`);
  console.log(`businessId  ${owner.businessId}`);

  const added = {
    wastageCodes: await addMissing(WastageCode, owner.businessId, SAMPLE_WASTAGE, apply),
    labourCodes: await addMissing(LabourCode, owner.businessId, SAMPLE_LABOUR, apply),
    itemCodes: await addMissing(ItemCode, owner.businessId, SAMPLE_ITEMS, apply),
  };
  for (const [kind, codes] of Object.entries(added)) {
    console.log(`${kind.padEnd(12)}${codes.length ? codes.join(', ') : '(all there already)'}`);
  }
  console.log(apply ? '\nADDED' : '\nDRY RUN (nothing is written; pass --apply to add these)');
  return { businessId: owner.businessId, applied: apply, added };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.phone) {
    throw new Error('usage: node scripts/seed_review_demo.js --phone <10 digits> [--apply]');
  }
  if (!config.mongodb?.uri) {
    throw new Error('MONGODB_URI is required');
  }
  await mongoose.connect(config.mongodb.uri.replace(/retryWrites=true/gi, 'retryWrites=false'));
  try {
    return await seedReviewDemo({ phone: String(args.phone), apply: Boolean(args.apply) });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { seedReviewDemo, SAMPLE_WASTAGE, SAMPLE_LABOUR, SAMPLE_ITEMS };
