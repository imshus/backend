#!/usr/bin/env node
/**
 * Puts back a sign-in record that was moved aside so its number could become
 * an employee: an owner of another shop (or a second owner of the same one),
 * or another shop's employee. Adding such a number (POST /employees, PUT
 * /employees/:id) archives the record whole in released_logins and prints
 * its id in an [EMPLOYEE_TRANSFER] log line. An account its holder deleted
 * (DELETE /auth/account, an owner's or an employee's) is archived the same
 * way, with reason ACCOUNT_DELETED and an [ACCOUNT_DELETED] log line, and
 * comes back the same way.
 *
 *   node scripts/restore_released_login.js <releasedLoginId>
 *
 * The record goes back into business_users exactly as it was — same id, same
 * shop, same MPIN — so its owner signs in as before, and an employee the move
 * (or the deletion) switched off is switched back on. (An employee who
 * deleted their account signs in again: the sessions they had stay over.
 * One their owner has switched back on since has a new sign-in record, and
 * is refused as below.) Refused, writing
 * nothing, while the number is someone else's (usually the employee it was
 * given to, or whoever registered it after a deletion: delete them or change
 * their number first), while the owner's Login ID is someone
 * else's, for an employee their shop has deleted, moved to another number or
 * given a new sign-in record since, or once it has been put back already.
 * Prints ids only.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../src/config/env');
const ReleasedLogin = require('../src/models/releasedLogin.model');
const employeeAccounts = require('../src/services/employeeAccount.service');

const USAGE = 'usage: node scripts/restore_released_login.js <releasedLoginId>';

// Why an entry is not put back, as the operator is told it.
const REFUSALS = {
  PHONE_ALREADY_REGISTERED: 'the number belongs to someone else now; free it first',
  USER_ID_TAKEN: "the owner's Login ID belongs to someone else now",
  EMPLOYEE_NOT_FOUND: 'their shop has deleted the employee since',
  EMPLOYEE_NUMBER_CHANGED: 'their shop has moved the employee to another number since',
  EMPLOYEE_HAS_LOGIN: 'their shop has given the employee a new sign-in record since',
};

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
    if (REFUSALS[error.message]) {
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
    } else {
      console.log(`\nnot restored: ${REFUSALS[result.reason] || result.reason}`);
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
