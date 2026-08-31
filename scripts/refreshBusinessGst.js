/**
 * Re-verifies a business's GSTIN against the live GSTN lookup and writes the
 * real details onto the business AND its users. Use this to replace records
 * captured while the server ran with GST_VERIFY_MODE=mock
 * (e.g. "Dev Mode Address, India").
 *
 *   node scripts/refreshBusinessGst.js --dry-run            # all businesses, report only
 *   node scripts/refreshBusinessGst.js                      # all businesses, apply
 *   node scripts/refreshBusinessGst.js 07ADIPG0941R1Z8      # one GSTIN, apply
 *
 * NOTE: each business costs one live GSTN lookup against your Sandbox account,
 * and the server must have GST_VERIFY_MODE=live with valid Sandbox keys.
 */

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const config = require('../src/config/env');
const gstService = require('../src/services/gst.service');
const Business = require('../src/models/business.model');
const BusinessUser = require('../src/models/businessUser.model');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY_GSTIN = args.find((a) => !a.startsWith('--'));

async function main() {
  if (config.gstVerifyMode !== 'live') {
    console.error(
      `GST_VERIFY_MODE is "${config.gstVerifyMode}" — set it to "live" (with Sandbox keys) first, ` +
        'otherwise this would rewrite records with mock data.',
    );
    process.exitCode = 1;
    return;
  }

  await connectDB();
  console.log(`Connected. Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);

  const filter = ONLY_GSTIN ? { gstNumber: ONLY_GSTIN.toUpperCase() } : {};
  const businesses = await Business.find(filter);
  console.log(`Businesses to refresh: ${businesses.length}\n`);

  let updated = 0;
  let failed = 0;

  for (const business of businesses) {
    try {
      const fresh = await gstService.verifyGST(business.gstNumber);
      if (fresh.isMock) {
        console.warn(`  ${business.gstNumber}: lookup returned mock data — skipped`);
        continue;
      }

      console.log(`  ${business.gstNumber}`);
      console.log(`    was: ${business.address}`);
      console.log(`    now: ${fresh.address}`);

      if (!DRY_RUN) {
        await Business.updateOne(
          { _id: business._id },
          {
            $set: {
              legalName: fresh.legalName || business.legalName,
              tradeName: fresh.tradeName || business.tradeName,
              address: fresh.address,
              businessType: fresh.businessType || business.businessType,
              companyType: fresh.companyType || business.companyType,
              gstStatus: fresh.gstStatus || business.gstStatus,
              stateCode: fresh.stateCode || business.stateCode,
              stateName: fresh.stateName || business.stateName,
              pincode: fresh.pincode || business.pincode,
            },
          },
        );

        const result = await BusinessUser.updateMany(
          { businessId: business._id },
          {
            $set: {
              address: fresh.address,
              gstNumber: business.gstNumber,
              businessName: fresh.tradeName || fresh.legalName || business.tradeName || '',
            },
          },
        );
        console.log(`    users updated: ${result.modifiedCount}`);
      }

      updated += 1;
    } catch (error) {
      failed += 1;
      console.error(`  ${business.gstNumber}: lookup failed — ${error.message}`);
    }
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}   Failed: ${failed}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Refresh failed:', error);
  process.exitCode = 1;
});
