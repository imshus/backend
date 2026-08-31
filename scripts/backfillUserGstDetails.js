/**
 * Backfills address + gstNumber onto business_users records created before
 * those fields existed, copying them from the user's business.
 *
 *   node scripts/backfillUserGstDetails.js           # apply
 *   node scripts/backfillUserGstDetails.js --dry-run # report only
 *
 * Safe to re-run: only fills fields that are currently empty, and never
 * overwrites a value that is already set.
 */

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  // Reuse the app's own connection helper so the URI handling matches exactly.
  await connectDB();
  console.log(`Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);

  const users = await BusinessUser.find({
    $or: [
      { address: { $in: [null, ''] } },
      { gstNumber: { $in: [null, ''] } },
      { businessName: { $in: [null, ''] } },
      { address: { $exists: false } },
      { gstNumber: { $exists: false } },
      { businessName: { $exists: false } },
    ],
  });

  console.log(`Users missing GST details: ${users.length}`);

  const businessCache = new Map();
  let updated = 0;
  let skipped = 0;

  for (const user of users) {
    const key = String(user.businessId);
    if (!businessCache.has(key)) {
      businessCache.set(key, await Business.findById(user.businessId));
    }
    const business = businessCache.get(key);

    if (!business) {
      console.warn(`  ${user.phone}: business ${key} not found — skipped`);
      skipped += 1;
      continue;
    }

    const update = {};
    if (!user.address && business.address) update.address = business.address;
    if (!user.gstNumber && business.gstNumber) update.gstNumber = business.gstNumber;
    const resolvedName = business.tradeName || business.legalName;
    if (!user.businessName && resolvedName) update.businessName = resolvedName;

    if (!Object.keys(update).length) {
      skipped += 1;
      continue;
    }

    console.log(
      `  ${user.phone} <- gst=${update.gstNumber ?? '(kept)'} name=${
        update.businessName ?? '(kept)'
      } address=${update.address ? `"${update.address}"` : '(kept)'}`,
    );

    if (!DRY_RUN) {
      await BusinessUser.updateOne({ _id: user._id }, { $set: update });
    }
    updated += 1;
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}   Skipped: ${skipped}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Backfill failed:', error);
  process.exitCode = 1;
});
