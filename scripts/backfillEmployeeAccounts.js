/**
 * Gives every employee added before sign-in records existed their record in
 * business_users (role EMP): their phone, the shop's GST details copied from
 * the owner's record, and a mirror of their permissions. No MPIN is set — the
 * owner sets one from the app (PUT /employees/:id/mpin) — so until then the
 * phone + MPIN login answers EMPLOYEE_MPIN_NOT_SET, and the old phone +
 * password login keeps working.
 *
 * Without this, each such employee gets their record anyway the first time
 * the owner edits them, sets their MPIN, or they sign in the old way; this
 * just does it for everyone at once, so their numbers are known to the login
 * and sign-up screens from today.
 *
 *   node scripts/backfillEmployeeAccounts.js           # report only
 *   node scripts/backfillEmployeeAccounts.js --apply   # write
 *
 * Safe to re-run. A number that is already another account's is reported and
 * left alone. Prints ids and masked numbers only.
 */

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const BusinessUser = require('../src/models/businessUser.model');
const Employee = require('../src/models/employee.model');
const employeeAccounts = require('../src/services/employeeAccount.service');
const { normalizeIndianMobile } = require('../src/utils/phone');

const APPLY = process.argv.includes('--apply');
const mask = (phone) => (phone ? `${phone.slice(0, 2)}******${phone.slice(-2)}` : '(none)');

async function main() {
  await connectDB();
  await BusinessUser.init();
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'REPORT ONLY (pass --apply to write)'}`);

  const linked = new Set(
    (await BusinessUser.find({ role: 'EMP', employeeId: { $exists: true } }).select('employeeId').lean())
      .map((account) => String(account.employeeId)),
  );
  const employees = await Employee.find({});
  const missing = employees.filter((employee) => !linked.has(String(employee._id)));
  console.log(`Employees: ${employees.length}, without a sign-in record: ${missing.length}`);

  const tally = { created: 0, noPhone: 0, numberInUse: 0 };
  for (const employee of missing) {
    const phone = normalizeIndianMobile(employee.phone);
    const label = `${employee._id} ${mask(phone)}`;
    if (!phone) {
      tally.noPhone += 1;
      console.log(`  skip ${label}: no valid phone`);
      continue;
    }
    if (await employeeAccounts.isPhoneRegistered(phone, { exceptEmployeeId: employee._id })) {
      tally.numberInUse += 1;
      console.log(`  skip ${label}: number already belongs to another account`);
      continue;
    }
    if (APPLY) {
      try {
        await employeeAccounts.createAccountFor(employee);
      } catch (error) {
        if (error.message === 'PHONE_ALREADY_REGISTERED') {
          tally.numberInUse += 1;
          console.log(`  skip ${label}: number already belongs to another account`);
          continue;
        }
        throw error;
      }
    }
    tally.created += 1;
    console.log(`  ${APPLY ? 'created' : 'would create'} ${label}`);
  }

  console.log(`Done. ${APPLY ? 'Created' : 'Would create'}: ${tally.created}, no phone: ${tally.noPhone}, number in use: ${tally.numberInUse}`);
}

main()
  .catch((error) => {
    console.error('Backfill failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
