const mongoose = require('mongoose');
const BusinessUser = require('../models/businessUser.model');
const Employee = require('../models/employee.model');
const employeeAccounts = require('./employeeAccount.service');
const otpService = require('./otp.service');
const { normalizeIndianMobile, storedSpellingsOf, loginLookupOf } = require('../utils/phone');

/**
 * Deleting one's own account (Settings → Delete Account, DELETE /auth/account).
 *
 * The owner's call (17 Oct 2026): remove the login, keep the data. The
 * caller's own business_users record is archived whole in released_logins
 * (reason ACCOUNT_DELETED) and taken out of business_users, the same way a
 * login moved to another shop is (employeeAccount.service archiveRelease), so
 * scripts/restore_released_login.js can put it back. An employee is also
 * switched off on their shop's roster, which is what ends their refresh. The
 * shop itself — business, invoices, scans, wallet and credits, payments,
 * licence, subscription, its other owners and employees — is never touched.
 *
 * Proved twice: a code texted to the account's own phone (flow ACCOUNT_DELETE,
 * under the caller's shop, checked here on the server), and the word DELETE
 * typed exactly.
 */

const EMP = employeeAccounts.EMP;
const ACCOUNT_DELETE_FLOW = 'ACCOUNT_DELETE';
const CONFIRMATION_WORD = 'DELETE';
const OTP_TTL_SECONDS = 10 * 60; // as otp.service stores it
const OTP_RESEND_AFTER_SECONDS = 30;

const sessionEnded = () => new Error('UNAUTHORIZED');
const objectIdOf = (value) => new mongoose.Types.ObjectId(String(value));

/** '+91 •••••43210': enough for the holder to know which phone, no more. */
const maskPhone = (phone) => `+91 •••••${String(phone).slice(-5)}`;

/**
 * The ten digits an Employee document's phone is, when it is stored as one of
 * the spellings the roster is matched by (storedSpellingsOf, '09876543210'
 * included, as archiveRelease matches it); '' otherwise.
 */
function tenDigitsOf(stored) {
  const tenDigits = normalizeIndianMobile(stored) || loginLookupOf(stored).phone || '';
  return tenDigits && storedSpellingsOf(tenDigits).includes(String(stored ?? '')) ? tenDigits : '';
}

/**
 * The caller's own sign-in, from their token. An employee's token carries
 * their Employee document's id: that employee, still on this shop's roster
 * and switched on, and their EMP record(s) as stored. Anyone else's carries
 * their business_users id: that record, in this shop, switched on. Gone or
 * switched off since → UNAUTHORIZED, as their next refresh would answer.
 * `phone` is the number the code goes to: the one they sign in with.
 */
async function ownLoginOf(user) {
  const { userId, businessId } = user || {};
  if (!mongoose.isValidObjectId(String(userId)) || !mongoose.isValidObjectId(String(businessId))) {
    throw sessionEnded();
  }
  const raw = BusinessUser.collection;

  if (String(user.role || '').trim().toUpperCase() === EMP) {
    const employee = await Employee.findOne({ _id: userId, businessId }).select('businessId phone isActive').lean();
    if (!employee || employee.isActive === false) throw sessionEnded();
    const logins = await raw.find({ employeeId: employee._id, role: EMP }).sort({ _id: 1 }).toArray();
    const phone = logins[0]?.phone || tenDigitsOf(employee.phone);
    if (!phone) throw new Error('ACCOUNT_PHONE_MISSING');
    return { kind: 'employee', phone, employee, logins };
  }

  const login = await raw.findOne({
    _id: objectIdOf(userId),
    businessId: objectIdOf(businessId),
    role: { $ne: EMP },
    isActive: { $ne: false },
  });
  if (!login) throw sessionEnded();
  return { kind: 'owner', phone: login.phone, employee: null, logins: [login] };
}

/**
 * POST /auth/account/delete-otp: texts a code to the caller's own phone. The
 * answer names the phone masked and never carries the code.
 */
async function sendDeleteOtp(user) {
  const own = await ownLoginOf(user);
  await otpService.sendMobileOtp({
    mobile: own.phone,
    flow: ACCOUNT_DELETE_FLOW,
    otpType: 'PHONE',
    businessId: user.businessId,
    destination: own.phone,
    route: '/api/v1/auth/account/delete-otp',
  });
  return {
    phoneMasked: maskPhone(own.phone),
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAfterSeconds: OTP_RESEND_AFTER_SECONDS,
  };
}

/**
 * DELETE /auth/account: with the word DELETE and the latest code this shop
 * texted to the caller's phone for this (unexpired, used once), releases the
 * caller's own sign-in and nothing else. Refusals, before anything is
 * written: CONFIRMATION_REQUIRED, OTP_INVALID / OTP_EXPIRED / OTP_NOT_FOUND /
 * OTP_ALREADY_USED, UNAUTHORIZED. If a step fails part-way, what was
 * released is put back.
 */
async function deleteOwnAccount(user, { otp, confirm } = {}) {
  if (confirm !== CONFIRMATION_WORD) throw new Error('CONFIRMATION_REQUIRED');
  const code = String(otp ?? '').trim();
  if (!/^[0-9]{6}$/.test(code)) throw new Error('OTP_INVALID');

  const own = await ownLoginOf(user);
  await otpService.verifyOtpByMobile({
    mobile: own.phone,
    otp: code,
    flow: ACCOUNT_DELETE_FLOW,
    businessId: user.businessId,
    rejectAlreadyVerified: true,
    route: '/api/v1/auth/account',
  });

  const by = {
    reason: 'ACCOUNT_DELETED',
    releasedAt: new Date(),
    releasedByBusinessId: user.businessId,
    releasedByUserId: String(user.userId),
  };
  const released = [];
  try {
    if (own.kind === 'owner') {
      const [login] = own.logins;
      await employeeAccounts.archiveRelease({ ...by, phone: login.phone, kind: 'owner' }, login, released);
    } else {
      const fields = {
        ...by,
        kind: 'employee',
        fromBusinessId: own.employee.businessId,
        employeeId: own.employee._id,
        previousIsActive: true,
      };
      // An employee from before sign-in records has none: switching them off
      // is the whole release.
      if (!own.logins.length) await employeeAccounts.archiveRelease({ ...fields, phone: own.phone }, null, released);
      for (const login of own.logins) {
        await employeeAccounts.archiveRelease({ ...fields, phone: login.phone }, login, released);
      }
      // Off on the roster whatever number it holds: the refresh reads this.
      await Employee.updateOne({ _id: own.employee._id }, { $set: { isActive: false } });
    }
  } catch (error) {
    await employeeAccounts.restoreReleased(released);
    // The record went in the meantime (another request took it first).
    if (error.message === 'PHONE_ALREADY_REGISTERED') throw sessionEnded();
    throw error;
  }

  return { success: true, message: 'Your account has been deleted.' };
}

module.exports = {
  ACCOUNT_DELETE_FLOW,
  CONFIRMATION_WORD,
  maskPhone,
  sendDeleteOtp,
  deleteOwnAccount,
};
