const bcrypt = require('bcryptjs');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const Employee = require('../models/employee.model');
const authService = require('./auth.service');
const { sealMpin, openMpin } = require('../utils/mpinVault');
const { normalizeIndianMobile, storedSpellingsOf } = require('../utils/phone');
const { toPlainPermissions } = require('../utils/permissions');

/**
 * An employee's sign-in record.
 *
 * An employee signs in exactly as the owner does — phone, OTP, MPIN — so each
 * one has a record in business_users with role EMP, holding:
 *   - the phone (unique across every account, owners and employees alike);
 *   - the MPIN the owner set, hashed for login and sealed for the owner's
 *     "show MPIN" (the same trade-off as the owner's own vault);
 *   - the shop's GST details, copied from the owner's record and refreshed
 *     with it — the same shop, never a business or GST registration of its own;
 *   - a copy of the employee's permissions.
 *
 * The Employee document stays the source of truth for name, designation,
 * permissions and isActive; this record follows it on every change and links
 * back through `employeeId`. Tokens issued for an employee carry the Employee
 * document's id, because that is what access checks and the employee's own
 * settings are keyed on.
 */

const EMP = 'EMP';

/** The GST and address fields an owner's record carries, and so an employee's. */
const SHOP_DETAIL_FIELDS = ['gstNumber', 'businessName', 'address'];

const phoneTaken = () => new Error('PHONE_ALREADY_REGISTERED');
const isDuplicateKey = (error) => error?.code === 11000;

/**
 * Whether a number is already someone's: any account in business_users
 * (owner, employee, any shop) or any active employee of any shop. Which shop
 * is never said. `except*` leave out the employee being edited and their own
 * sign-in record, so keeping one's own number is not a clash.
 */
async function isPhoneRegistered(phone, { exceptEmployeeId = null, exceptUserId = null } = {}) {
  const tenDigits = normalizeIndianMobile(phone);
  if (!tenDigits) return false;

  const userFilter = { phone: tenDigits };
  if (exceptUserId) userFilter._id = { $ne: exceptUserId };
  const employeeFilter = { phone: { $in: storedSpellingsOf(tenDigits) }, isActive: { $ne: false } };
  if (exceptEmployeeId) employeeFilter._id = { $ne: exceptEmployeeId };

  const [user, employee] = await Promise.all([
    BusinessUser.exists(userFilter),
    Employee.exists(employeeFilter),
  ]);
  return Boolean(user || employee);
}

/**
 * The GST details as the business record holds them — the GSTIN, the name the
 * app shows for the shop, the address — in the user records' field names.
 */
function businessDetailsOf(business) {
  const clean = (value) => String(value ?? '').trim();
  return {
    gstNumber: clean(business?.gstNumber),
    businessName: clean(business?.tradeName || business?.legalName),
    address: clean(business?.address),
  };
}

/** The user-record fields whose copy differs from what the business holds. */
function staleShopFields(user, fromBusiness) {
  return SHOP_DETAIL_FIELDS.filter(
    (field) => fromBusiness[field] && String(user?.[field] ?? '').trim() !== fromBusiness[field],
  );
}

/**
 * The shop's GST number, name and address as the owner's record carries them,
 * once that record is brought up to date.
 *
 * The owner's record is a copy of the business record, taken at registration,
 * and the business record is where a later GSTIN change lands — and what the
 * owner's own login and profile show. A GSTIN changed before the Profile
 * screen also wrote the user records left the owner's copy on the old number,
 * name and address, so before anything is copied from it, every field the
 * business holds a different value for is healed on the owner's record (and
 * the shop's employee records with it, as a GSTIN change does). A blank on the
 * business keeps what the owner's record has; an owner from before the user
 * record held these at all is filled from the business.
 */
async function shopDetailsOf(businessId) {
  const [owner, business] = await Promise.all([
    BusinessUser.findOne({ businessId, role: 'OWNER' })
      .sort({ createdAt: 1 })
      .select(SHOP_DETAIL_FIELDS.join(' '))
      .lean(),
    Business.findById(businessId).select('gstNumber legalName tradeName address').lean(),
  ]);
  const fromBusiness = businessDetailsOf(business);
  const shop = Object.fromEntries(SHOP_DETAIL_FIELDS.map(
    (field) => [field, fromBusiness[field] || String(owner?.[field] ?? '').trim()],
  ));

  const stale = owner ? staleShopFields(owner, fromBusiness) : [];
  if (stale.length) {
    const healed = Object.fromEntries(stale.map((field) => [field, fromBusiness[field]]));
    // The same writes a GSTIN change on the Profile screen makes: the shop's
    // own records take the business's values, its employees the whole copy.
    await BusinessUser.updateMany({ businessId, role: { $ne: EMP } }, { $set: healed });
    await BusinessUser.updateMany({ businessId, role: EMP }, { $set: shop });
  }
  return shop;
}

/** Copies the owner's GST details onto every employee record of the shop. */
async function syncShopDetailsToEmployees(businessId) {
  const shop = await shopDetailsOf(businessId);
  return BusinessUser.updateMany({ businessId, role: EMP }, { $set: shop });
}

const mpinFields = async (mpin) => ({
  // The same cost as the owner's MPIN: the work factor is what makes four
  // digits survivable at rest.
  mpinHash: await bcrypt.hash(String(mpin), 10),
  mpinVault: sealMpin(String(mpin)),
});

/** The employee's sign-in record, lean, without the sealed MPIN. */
function findAccountOf(employee) {
  return BusinessUser.findOne({ employeeId: employee._id, role: EMP }).lean();
}

async function linkEmployee(employee, accountId) {
  if (employee.businessUserId && String(employee.businessUserId) === String(accountId)) return;
  await Employee.updateOne({ _id: employee._id }, { $set: { businessUserId: accountId } });
  employee.businessUserId = accountId;
}

/**
 * Creates the sign-in record for an employee. Refuses (PHONE_ALREADY_REGISTERED)
 * when the number is already an account's — the unique phone index is the
 * final word if two requests race past the earlier check.
 */
async function createAccountFor(employee, { mpin } = {}) {
  const phone = normalizeIndianMobile(employee.phone);
  if (!phone) throw new Error('EMPLOYEE_PHONE_REQUIRED');

  const doc = {
    businessId: employee.businessId,
    phone,
    fullName: employee.name || '',
    role: EMP,
    employeeId: employee._id,
    permissions: toPlainPermissions(employee.permissions),
    isActive: employee.isActive !== false,
    // The owner typed this number; no code has been sent to it yet.
    phoneVerified: false,
    ...(await shopDetailsOf(employee.businessId)),
    ...(mpin ? await mpinFields(mpin) : {}),
  };

  let account;
  try {
    account = await BusinessUser.create(doc);
  } catch (error) {
    if (isDuplicateKey(error)) throw phoneTaken();
    throw error;
  }
  await linkEmployee(employee, account._id);
  // The sealed copy stays in the database; nothing downstream needs it.
  const { mpinVault: _sealed, ...created } = account.toObject();
  return created;
}

/**
 * Brings the sign-in record in line with the Employee document after any
 * change: phone, name, permissions, active or not, and the shop's GST details.
 * An employee from before these records existed gets one here, when they
 * have a phone to sign in with. Throws PHONE_ALREADY_REGISTERED when the new
 * number is another account's.
 */
async function syncAccountOf(employee, { account, createIfMissing = true } = {}) {
  const current = account === undefined ? await findAccountOf(employee) : account;
  if (!current) {
    if (!createIfMissing || !normalizeIndianMobile(employee.phone)) return null;
    return createAccountFor(employee);
  }

  const set = {
    fullName: employee.name || '',
    permissions: toPlainPermissions(employee.permissions),
    isActive: employee.isActive !== false,
    ...(await shopDetailsOf(employee.businessId)),
  };
  const phone = normalizeIndianMobile(employee.phone);
  if (phone && phone !== current.phone) {
    set.phone = phone;
    set.phoneVerified = false;
  }

  try {
    await BusinessUser.updateOne({ _id: current._id, role: EMP }, { $set: set });
  } catch (error) {
    if (isDuplicateKey(error)) throw phoneTaken();
    throw error;
  }
  await linkEmployee(employee, current._id);
  return { ...current, ...set };
}

/**
 * Sets (or replaces) the MPIN the employee signs in with, creating their
 * sign-in record first if they are from before these existed.
 */
async function setMpinFor(employee, mpin) {
  const account = await findAccountOf(employee);
  if (account) {
    await BusinessUser.updateOne({ _id: account._id, role: EMP }, { $set: await mpinFields(mpin) });
    return account;
  }
  if (!normalizeIndianMobile(employee.phone)) throw new Error('EMPLOYEE_PHONE_REQUIRED');
  if (await isPhoneRegistered(employee.phone, { exceptEmployeeId: employee._id })) throw phoneTaken();
  return createAccountFor(employee, { mpin });
}

/** The employee's MPIN read back from the sealed copy; null when there is none. */
async function readMpinOf(employee) {
  const account = await BusinessUser.findOne({ employeeId: employee._id, role: EMP })
    .select('+mpinVault')
    .lean();
  return openMpin(account?.mpinVault);
}

/** Deletes the employee's sign-in record(s). */
function removeAccountOf(employeeId) {
  return BusinessUser.deleteMany({ employeeId, role: EMP });
}

/**
 * Employees as GET /employees returns them: the document without its password
 * hash, plus whether the owner has set an MPIN yet. Never the MPIN itself.
 */
async function presentEmployees(employees) {
  const list = Array.isArray(employees) ? employees : [employees];
  const ids = list.map((employee) => employee._id);
  const accounts = ids.length
    ? await BusinessUser.find({ employeeId: { $in: ids }, role: EMP }).select('employeeId mpinHash').lean()
    : [];
  const hasMpin = new Map(accounts.map((account) => [String(account.employeeId), Boolean(account.mpinHash)]));

  return list.map((employee) => {
    const json = typeof employee.toJSON === 'function' ? employee.toJSON() : { ...employee };
    delete json.passwordHash;
    json.hasMpin = hasMpin.get(String(employee._id)) || false;
    return json;
  });
}

async function presentEmployee(employee) {
  const [json] = await presentEmployees([employee]);
  return json;
}

/**
 * The session an employee gets, from either login: a token keyed on the
 * Employee document's id with role EMP and a copy of the permissions, and the
 * same payload the owner's login returns, with the shop's GST details as they
 * are now (`shop`, when the caller already read them).
 */
async function employeeSession(employee, account = null, shop = null) {
  const [business, details] = await Promise.all([
    Business.findById(employee.businessId),
    shop || shopDetailsOf(employee.businessId),
  ]);
  const permissions = toPlainPermissions(employee.permissions);
  const tokens = authService.generateTokens(
    String(employee.businessId),
    String(employee._id),
    EMP,
    { permissions },
  );

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    businessId: String(employee.businessId),
    userId: String(employee._id),
    loginId: '',
    fullName: employee.name || '',
    designation: employee.designation || '',
    role: EMP,
    permissions,
    businessName: details.businessName || undefined,
    gstNumber: details.gstNumber || undefined,
    businessType: business ? (business.companyType || business.businessType) : undefined,
    address: details.address || undefined,
    phone: account?.phone || normalizeIndianMobile(employee.phone) || '',
  };
}

/**
 * Signs an employee in with the MPIN their owner set, given the sign-in record
 * their phone found. Wrong MPIN and unknown employee look the same; an
 * employee whose owner has not set an MPIN is told so, distinctly, and one
 * the owner switched off is told so only once the MPIN has proved it is them.
 */
async function signInWithMpin(account, mpin) {
  const employee = account?.employeeId
    ? await Employee.findOne({ _id: account.employeeId, businessId: account.businessId })
    : null;
  if (!employee) throw new Error('INVALID_PHONE_CREDENTIALS');

  const active = employee.isActive !== false && account.isActive !== false;
  if (!account.mpinHash) {
    throw new Error(active ? 'EMPLOYEE_MPIN_NOT_SET' : 'INVALID_PHONE_CREDENTIALS');
  }
  if (!mpin || !(await bcrypt.compare(String(mpin), account.mpinHash))) {
    throw new Error('INVALID_PHONE_CREDENTIALS');
  }
  if (!active) throw new Error('EMPLOYEE_INACTIVE');

  const now = new Date();
  const accountUpdate = { lastLoginAt: now };
  // As for the owner: an MPIN hashed before the sealed copy existed gets one
  // the first time it is proved right.
  if (!account.mpinVault) accountUpdate.mpinVault = sealMpin(String(mpin));
  // And as the owner's login does for theirs: a copy of the shop's GST
  // details that has fallen behind is brought up to date.
  const shop = await shopDetailsOf(employee.businessId);
  for (const field of SHOP_DETAIL_FIELDS) {
    if (String(account[field] ?? '') !== shop[field]) accountUpdate[field] = shop[field];
  }
  await Promise.all([
    BusinessUser.updateOne({ _id: account._id, role: EMP }, { $set: accountUpdate }),
    Employee.updateOne({ _id: employee._id }, { $set: { lastLoginAt: now } }),
  ]);

  return employeeSession(employee, account, shop);
}

module.exports = {
  EMP,
  SHOP_DETAIL_FIELDS,
  isPhoneRegistered,
  businessDetailsOf,
  staleShopFields,
  shopDetailsOf,
  syncShopDetailsToEmployees,
  findAccountOf,
  createAccountFor,
  syncAccountOf,
  setMpinFor,
  readMpinOf,
  removeAccountOf,
  presentEmployees,
  presentEmployee,
  employeeSession,
  signInWithMpin,
};
