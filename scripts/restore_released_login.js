#!/usr/bin/env node
/**
 * Puts back a sign-in record that was moved aside so its number could become
 * an employee: an owner of another shop (or a second owner of the same one),
 * or another shop's employee. Adding such a number (POST /employees, PUT
 * /employees/:id) archives the record whole in released_logins and prints
 * its id in an [EMPLOYEE_TRANSFER] log line.
 *
 *   node scripts/restore_released_login.js <releasedLoginId>
 *
 * The record goes back into business_users exactly as it was — same id, same
 * shop, same MPIN — so its owner signs in as before, and an employee the move
 * switched off is switched back on. Refused, writing nothing, while the
 * number is someone else's (usually the employee it was given to: delete
 * them or change their number first), for an employee their shop has
 * deleted since, or once it has been put back already. Prints ids only.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../src/config/env');
const ReleasedLogin = require('../src/models/releasedLogin.model');
const employeeAccounts = require('../src/services/employeeAccount.service');

const USAGE = 'usage: node scripts/restore_released_login.js <releasedLoginId>';

/**
 * Restores one released_logins entry. Answers { restored, reason } and the
 * ids involved; throws only for an id that names no entry.
 */
async function restoreReleasedLogin(releasedLoginId) {
  if (!mongoose.isValidObjectId(String(releasedLoginId || ''))) throw new Error(USAGE);
  const entry = await ReleasedLogin.findById(releasedLoginId);
  if (!entry) throw new Error(`No released login ${releasedLoginId}`);

  const ids = {
    releasedId: String(entry._id),
    kind: entry.kind,
    loginId: entry.original?._id ? String(entry.original._id) : null,
    employeeId: entry.employeeId ? String(entry.employeeId) : null,
    fromBusinessId: entry.fromBusinessId ? String(entry.fromBusinessId) : null,
  };
  try {
    const result = await employeeAccounts.restoreRelease(entry, { check: true });
    return { ...ids, restored: result.restored, reason: result.reason || null };
  } catch (error) {
    if (['PHONE_ALREADY_REGISTERED', 'EMPLOYEE_NOT_FOUND'].includes(error.message)) {
      return { ...ids, restored: false, reason: error.message };
    }
    throw error;
  }
}

async function main() {
  const releasedLoginId = process.argv[2];
  if (!releasedLoginId) throw new Error(USAGE);
  if (!config.mongodb?.uri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(config.mongodb.uri.replace(/retryWrites=true/gi, 'retryWrites=false'));
  try {
    const result = await restoreReleasedLogin(releasedLoginId);
    console.log(`released    ${result.releasedId} (${result.kind})`);
    console.log(`login       ${result.loginId || '(none: an employee without a sign-in record)'}`);
    if (result.employeeId) console.log(`employee    ${result.employeeId}`);
    console.log(`shop        ${result.fromBusinessId || '(unknown)'}`);
    if (result.restored) {
      console.log('\nRESTORED: the record is back in business_users and signs in as before');
    } else if (result.reason === 'PHONE_ALREADY_REGISTERED') {
      console.log('\nnot restored: the number belongs to someone else now; free it first');
    } else if (result.reason === 'EMPLOYEE_NOT_FOUND') {
      console.log('\nnot restored: their shop has deleted the employee since');
    } else {
      console.log(`\nnot restored: ${result.reason}`);
    }
    return result;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then((result) => process.exit(result.restored ? 0 : 1))
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = { restoreReleasedLogin };
