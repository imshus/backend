#!/usr/bin/env node
/**
 * Puts one shop on a permanent licence ("pro"), by the number its owner
 * signs in with — what support is given to search on.
 *
 *   node scripts/grant_license.js --phone 8084286876            # dry run: shows the shop, writes nothing
 *   node scripts/grant_license.js --phone 8084286876 --apply    # activates the licence
 *   node scripts/grant_license.js --phone 8084286876 --apply --amount 12000
 *   node scripts/grant_license.js --phone 8084286876 --apply --no-bonus
 *
 * Goes through licenseService.activatePermanentLicense, the path a Razorpay
 * purchase takes, so the record reads like a purchase (dated now; order and
 * payment ids empty, since there was no payment; amount 0 unless --amount is
 * given), the wallet is enabled, the referral reward fires, and a shop that is
 * already permanent is left alone. The purchase bonus credits a paying shop
 * gets (billing config's purchasedBonusCredits, 1000 unless changed) are
 * granted too, unless --no-bonus. No licence-transaction row is written:
 * those belong to payments, and there was none.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../src/config/env');
const BusinessUser = require('../src/models/businessUser.model');
const Business = require('../src/models/business.model');
const OrganizationLicense = require('../src/models/organizationLicense.model');
const licenseService = require('../src/services/license.service');
const creditService = require('../src/services/credit.service');
const billingConfigService = require('../src/services/billingConfig.service');

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

/**
 * The shop behind a sign-in number, read without writing anything: the
 * licence recorded against the number, else the owner account with it.
 */
async function findShop(phone) {
  const normalized = tenDigits(phone);
  if (normalized.length !== 10) {
    throw new Error('--phone must be the 10-digit number the owner signs in with');
  }

  let license = await OrganizationLicense.findOne({ ownerPhone: normalized }).lean();
  let businessId = license?.businessId ?? null;

  if (!businessId) {
    const owner = await BusinessUser.findOne({ phone: normalized, role: 'OWNER' })
      .sort({ createdAt: 1 })
      .lean();
    if (!owner) return null;
    businessId = owner.businessId;
    license = await OrganizationLicense.findOne({ businessId }).lean();
  }

  const business = await Business.findById(businessId).lean();
  return { phone: normalized, businessId, business, license };
}

/**
 * @param {object} options
 * @param {string} options.phone     The owner's sign-in number.
 * @param {boolean} options.apply    Write. Without it nothing is saved.
 * @param {number} [options.amount]  Recorded as the purchase amount (default 0).
 * @param {boolean} [options.bonus]  Grant the purchase bonus credits too (default true).
 */
async function grantLicense({ phone, apply = false, amount = 0, bonus = true }) {
  const shop = await findShop(phone);
  if (!shop) {
    throw new Error(`No owner account signs in with ${tenDigits(phone)}`);
  }

  const status = shop.license?.licenseStatus || 'NO_LICENSE (no licence record yet)';
  console.log(`shop        ${shop.business?.tradeName || shop.business?.legalName || '(no name)'}`);
  console.log(`gstin       ${shop.business?.gstNumber || '(none)'}`);
  console.log(`businessId  ${shop.businessId}`);
  console.log(`licence     ${status}`);
  if (shop.license?.trialEndDate) {
    console.log(`trial ends  ${new Date(shop.license.trialEndDate).toISOString()}`);
  }

  if (shop.license?.licenseStatus === 'PERMANENT_LICENSE') {
    console.log('already on a permanent licence; nothing to do');
    return { activated: false, reason: 'LICENSE_ALREADY_PERMANENT', businessId: shop.businessId };
  }

  if (!apply) {
    console.log('\nDRY RUN (nothing is written; pass --apply to activate)');
    return { activated: false, reason: 'DRY_RUN', businessId: shop.businessId };
  }

  const result = await licenseService.activatePermanentLicense({
    businessId: shop.businessId,
    actorUserId: null,
    purchaseAmount: Number(amount || 0),
  });

  console.log(
    result.activated
      ? `\nACTIVATED: ${shop.phone} is on a permanent licence (amount recorded: ${Number(amount || 0)})`
      : `\nnot activated: ${result.reason}`,
  );

  // What a paying shop gets with its licence, granted the same way
  // payment.service does it on a verified purchase.
  if (result.activated && bonus) {
    const cfg = await billingConfigService.getEffectiveConfig();
    const bonusCredits = Number(cfg.purchasedBonusCredits || 1000);
    await creditService.grantPurchaseBonusCredits({
      businessId: shop.businessId,
      actionByUserId: null,
      credits: bonusCredits,
      note: 'Application purchase bonus, licence granted by scripts/grant_license.js',
      metadata: { source: 'grant_license.js' },
    });
    console.log(`bonus       ${bonusCredits} credits granted`);
  }
  return { activated: result.activated, reason: result.reason || null, businessId: shop.businessId };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.phone) {
    throw new Error('usage: node scripts/grant_license.js --phone <10 digits> [--apply] [--amount <rupees>]');
  }
  if (!config.mongodb?.uri) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(config.mongodb.uri.replace(/retryWrites=true/gi, 'retryWrites=false'));
  try {
    return await grantLicense({
      phone: String(args.phone),
      apply: Boolean(args.apply),
      amount: args.amount ? Number(args.amount) : 0,
      bonus: !(args['no-bonus'] || args.noBonus),
    });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then((result) => process.exit(result.activated || result.reason === 'LICENSE_ALREADY_PERMANENT' || result.reason === 'DRY_RUN' ? 0 : 1))
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = { grantLicense, findShop, parseArgs };
