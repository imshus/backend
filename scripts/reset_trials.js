#!/usr/bin/env node
/**
 * Puts every shop back on a free trial.
 *
 * A trial that ran out did two things: it set the licence to NO_LICENSE with a
 * trialExpiredAt, and it threw away whatever credits were left in the wallet.
 * Clearing the licence alone would hand a shop an active trial with an empty
 * wallet, so the credits come back with it.
 *
 *   node scripts/reset_trials.js                  # dry run: says what it would do
 *   node scripts/reset_trials.js --apply          # 7-day trial from now
 *   node scripts/reset_trials.js --apply --days 14
 *   node scripts/reset_trials.js --apply --no-expiry   # a trial with no end date
 *
 * --no-expiry leaves trialEndDate null, which the expiry check in
 * license.service reads as "nothing to expire": the trial then runs until
 * someone ends it. Credits still run down as scans are made.
 *
 * Shops on a PERMANENT_LICENSE are left alone by default — they have paid, and
 * a trial would take away what they bought. --include-permanent overrides that
 * for a deployment where nobody has really purchased yet; the purchase fields
 * are left on the record either way, so it can be put back.
 *
 * Nobody's balance is lowered: a wallet already above the trial grant keeps
 * what it has.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../src/config/env');
const OrganizationLicense = require('../src/models/organizationLicense.model');
const billingConfigService = require('../src/services/billingConfig.service');
const walletService = require('../src/services/wallet.service');

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

const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

/**
 * @param {object} options
 * @param {number} options.days        Length of the new trial. Ignored when noExpiry.
 * @param {boolean} options.noExpiry   Leave trialEndDate null.
 * @param {boolean} options.apply      Write. Without it nothing is saved.
 * @param {number} [options.credits]   Credits to top each wallet up to.
 *                                     Defaults to each licence's own trialCredits.
 */
async function resetTrials({
  days = 7,
  noExpiry = false,
  apply = false,
  credits,
  includePermanent = false,
} = {}) {
  const now = new Date();
  const licenses = await OrganizationLicense.find({});
  const summary = { total: licenses.length, reset: 0, skippedPermanent: 0, creditsTopped: 0 };

  for (const license of licenses) {
    const businessId = String(license.businessId);

    if (license.licenseStatus === 'PERMANENT_LICENSE' && !includePermanent) {
      summary.skippedPermanent += 1;
      console.log(`skip     ${businessId}  PERMANENT_LICENSE`);
      continue;
    }

    const was = license.licenseStatus;
    const grant = Number(credits ?? license.trialCredits ?? 0);
    // Worked out before the write so a dry run reports the date it WOULD set,
    // not the one the record still holds.
    const nextEnd = noExpiry ? null : addDays(now, days);

    if (apply) {
      license.licenseStatus = 'FREE_TRIAL_LICENSE';
      license.trialDays = noExpiry ? 0 : days;
      license.trialStartDate = now;
      license.trialEndDate = nextEnd;
      // The gate that refuses a second trial, and the mark the app reads as
      // "this shop's trial is over".
      license.trialExpiredAt = null;
      await license.save();
    }

    summary.reset += 1;
    const until = nextEnd ? nextEnd.toISOString() : 'no end date';
    console.log(`reset    ${businessId}  ${was} -> FREE_TRIAL_LICENSE  until ${until}`);

    // Credits only ever go up: a wallet holding more than the grant is left
    // alone, so nothing bought or awarded is destroyed by a reset.
    const wallet = await walletService.ensureWallet(license.businessId);
    const balance = Number(wallet.creditBalance || 0);
    if (grant > balance) {
      if (apply) {
        await walletService.setCredits({
          businessId: license.businessId,
          targetAmount: grant,
          type: 'TRIAL_CREDIT',
          note: 'Trial reset',
          metadata: { resetAt: now, trialDays: noExpiry ? null : days },
        });
      }
      summary.creditsTopped += 1;
      console.log(`credits  ${businessId}  ${balance} -> ${grant}`);
    }
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  const apply = Boolean(args.apply);
  const noExpiry = Boolean(args['no-expiry'] || args.noExpiry);
  const cfg = await billingConfigService.getEffectiveConfig().catch(() => ({}));
  const days = Number(args.days || cfg.trialDays || 7);

  if (!config.mongodb?.uri) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(config.mongodb.uri.replace(/retryWrites=true/gi, 'retryWrites=false'));
  console.log(`${apply ? 'APPLYING' : 'DRY RUN (nothing is written; pass --apply)'}`);
  console.log(noExpiry ? 'trial: no end date' : `trial: ${days} days from now`);

  const includePermanent = Boolean(args['include-permanent'] || args.includePermanent);
  if (includePermanent) {
    console.log('including shops on a permanent licence — they will be put on a trial');
  }

  const summary = await resetTrials({
    days,
    noExpiry,
    apply,
    includePermanent,
    credits: args.credits ? Number(args.credits) : undefined,
  });

  console.log('\n--- summary');
  console.log(`licences            ${summary.total}`);
  console.log(`reset to trial      ${summary.reset}`);
  console.log(`left on permanent   ${summary.skippedPermanent}`);
  console.log(`wallets topped up   ${summary.creditsTopped}`);
  if (!apply) console.log('\nnothing was written — re-run with --apply');

  await mongoose.disconnect();
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { resetTrials };
