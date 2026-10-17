const bcrypt = require('bcryptjs');
const Business = require('../models/business.model');
const BusinessUser = require('../models/businessUser.model');
const Employee = require('../models/employee.model');
const ReleasedLogin = require('../models/releasedLogin.model');
const authService = require('./auth.service');
const { sealMpin, openMpin } = require('../utils/mpinVault');
const { normalizeIndianMobile, storedSpellingsOf, isStoredPhone } = require('../utils/phone');
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
/** The unique field a duplicate-key error is about ('phone', 'userId'). */
const duplicateFieldOf = (error) => Object.keys(error?.keyPattern || error?.keyValue || {})[0] || null;

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
 * Who holds a number, as the owner adding it as an employee sees it:
 *   - 'free'     nobody;
 *   - 'own'      the owner's own sign-in — never made their own employee;
 *   - 'taken'    a SUPER account, or this shop's own employee;
 *   - 'transfer' only records that may be moved here: an OWNER record of
 *                another shop, or of this one when it is not the caller (a
 *                second owner), and/or another shop's employees. A number
 *                held by several is moved from all of them together.
 * `transfer` says what the app shows ({ kind, sameShop }, an owner over an
 * employee), and `owner` / `employees` what releasePhoneHolders takes off.
 * `except*` leave out the employee being edited and their own record.
 */
async function classifyPhone(phone, {
  businessId,
  userId = null,
  exceptEmployeeId = null,
  exceptUserId = null,
} = {}) {
  const claim = { status: 'free', transfer: null, owner: null, employees: [] };
  const tenDigits = normalizeIndianMobile(phone);
  if (!tenDigits) return claim;

  const userFilter = { phone: tenDigits };
  if (exceptUserId) userFilter._id = { $ne: exceptUserId };
  const employeeFilter = { phone: { $in: storedSpellingsOf(tenDigits) }, isActive: { $ne: false } };
  if (exceptEmployeeId) employeeFilter._id = { $ne: exceptEmployeeId };

  const [user, employees] = await Promise.all([
    BusinessUser.findOne(userFilter).select('businessId role employeeId').lean(),
    Employee.find(employeeFilter).select('businessId').lean(),
  ]);
  const same = (a, b) => Boolean(a && b) && String(a) === String(b);
  // The employee being edited is not a clash through their record either.
  const login = user && !same(user.employeeId, exceptEmployeeId) ? user : null;
  const role = String(login?.role || '').toUpperCase();
  const thisShop = (id) => same(id, businessId);

  const callers = [login?._id, login?.employeeId, ...employees.map((employee) => employee._id)];
  if (callers.some((id) => same(id, userId))) return { ...claim, status: 'own' };
  if (
    (login && role !== 'OWNER' && role !== EMP)
    || (role === EMP && thisShop(login.businessId))
    || employees.some((employee) => thisShop(employee.businessId))
  ) {
    return { ...claim, status: 'taken' };
  }

  // Another shop's employees, by the active Employee documents and by the
  // EMP record on the number (switched off or not, it holds the number).
  const moving = new Map(employees.map((employee) => [
    String(employee._id),
    { employeeId: employee._id, fromBusinessId: employee.businessId, loginId: null },
  ]));
  if (role === EMP) {
    const key = String(login.employeeId || login._id);
    moving.set(key, {
      employeeId: login.employeeId || null,
      fromBusinessId: login.businessId,
      ...moving.get(key),
      loginId: login._id,
    });
  }

  const owner = role === 'OWNER' ? login : null;
  if (!owner && !moving.size) return claim;
  return {
    status: 'transfer',
    transfer: { kind: owner ? 'owner' : 'employee', sameShop: Boolean(owner && thisShop(owner.businessId)) },
    owner,
    employees: [...moving.values()],
  };
}

/** The log line a release writes under: a transfer, or an account its holder deleted. */
const logTagOf = (entry) => (entry?.reason === 'ACCOUNT_DELETED' ? '[ACCOUNT_DELETED]' : '[EMPLOYEE_TRANSFER]');

/** Takes back an entry that turned out to release nothing. */
async function withdrawRelease(entry, released) {
  released.splice(released.indexOf(entry), 1);
  try {
    await ReleasedLogin.deleteOne({ _id: entry._id });
  } catch (error) {
    console.error(`${logTagOf(entry)} could not withdraw`, { releasedId: String(entry._id), error: error.message });
  }
}

/**
 * Moves one holder of the number aside: archives their business_users record
 * whole in released_logins, deletes it (so the number is free and its
 * sessions end at their next refresh), then switches another shop's employee
 * off. The entry is written first and joins `released` at once, so a failure
 * at any later step is undone with the rest (restoreReleased).
 *
 * The record is deleted only while it still holds the number, and only what
 * this call actually removed stays archived: a record another request took
 * first (two shops claiming one number at once) answers PHONE_ALREADY_REGISTERED
 * with its entry withdrawn. An employee without a record is released by being
 * switched off here; one already off holds nothing and leaves no entry.
 * Deleting one's own account (accountRelease.service) releases the same way,
 * with reason ACCOUNT_DELETED.
 */
async function archiveRelease(fields, original, released) {
  const switchOff = Boolean(fields.employeeId) && fields.previousIsActive === true;
  if (!original && !switchOff) return null;

  const entry = await ReleasedLogin.create({
    ...fields,
    fromBusinessId: original?.businessId ?? fields.fromBusinessId ?? null,
    original,
  });
  released.push(entry);

  if (original) {
    const { deletedCount } = await BusinessUser.collection.deleteOne({ _id: original._id, phone: original.phone });
    if (!deletedCount) {
      await withdrawRelease(entry, released);
      throw phoneTaken();
    }
  }
  if (switchOff) {
    const { matchedCount } = await Employee.updateOne(
      { _id: fields.employeeId, isActive: { $ne: false }, phone: { $in: storedSpellingsOf(fields.phone) } },
      { $set: { isActive: false } },
    );
    if (!original && !matchedCount) {
      await withdrawRelease(entry, released);
      return null;
    }
  }

  // Ids and shops only: never the number's codes, hashes or tokens. An
  // account deleted by its holder went to no other shop.
  const ids = {
    kind: entry.kind,
    fromBusinessId: entry.fromBusinessId ? String(entry.fromBusinessId) : null,
    releasedLoginId: original ? String(original._id) : null,
    employeeId: entry.employeeId ? String(entry.employeeId) : null,
    releasedId: String(entry._id),
  };
  if (entry.reason === 'ACCOUNT_DELETED') {
    console.info(logTagOf(entry), ids);
  } else {
    console.info(logTagOf(entry), { ...ids, toBusinessId: String(entry.releasedByBusinessId) });
  }
  return entry;
}

/**
 * Takes the number classifyPhone found transferable off everyone holding it,
 * for this shop (`businessId`) and this owner (`userId`): the OWNER record is
 * archived and deleted; another shop's employee is switched off and their
 * EMP record on this number archived and deleted. Only holders that still
 * hold the number are touched. Businesses, invoices, scans, wallets and
 * licences are never touched. Answers the released_logins entries written,
 * for restoreReleased; if any step fails, what was released is put back
 * (and each entry's id logged as it goes back, or as it could not).
 */
async function releasePhoneHolders(claim, { businessId, userId, phone }) {
  const by = {
    phone: normalizeIndianMobile(phone),
    reason: 'MADE_EMPLOYEE',
    releasedAt: new Date(),
    releasedByBusinessId: businessId,
    releasedByUserId: String(userId || ''),
  };
  const raw = BusinessUser.collection;
  const released = [];
  try {
    if (claim.owner) {
      // Only while it still holds this number: one changed since is left alone.
      const original = await raw.findOne({ _id: claim.owner._id, phone: by.phone });
      if (original) await archiveRelease({ ...by, kind: 'owner' }, original, released);
    }
    for (const holder of claim.employees) {
      const employee = holder.employeeId
        ? await Employee.findById(holder.employeeId).select('isActive phone').lean()
        : null;
      // Their roster entry is switched off only while it is still on this
      // number; null leaves it as it is (and a restore leaves it too).
      const onThisNumber = Boolean(employee) && isStoredPhone(by.phone, employee.phone);
      const fields = {
        ...by,
        kind: 'employee',
        fromBusinessId: holder.fromBusinessId,
        employeeId: holder.employeeId || null,
        previousIsActive: onThisNumber ? employee.isActive !== false : null,
      };
      // Their sign-in records on this number: one moved to another number
      // since does not hold it.
      const logins = holder.employeeId
        ? await raw.find({ employeeId: holder.employeeId, role: EMP, phone: by.phone }).toArray()
        : [];
      if (holder.loginId && !logins.some((login) => String(login._id) === String(holder.loginId))) {
        const stray = await raw.findOne({ _id: holder.loginId, phone: by.phone });
        if (stray) logins.push(stray);
      }
      if (!logins.length) {
        await archiveRelease(fields, null, released);
        continue;
      }
      for (const login of logins) await archiveRelease(fields, login, released);
    }
  } catch (error) {
    await restoreReleased(released);
    throw error;
  }
  return released;
}

/**
 * Puts one released entry back: the record into business_users exactly as it
 * was (the unique indexes refuse it if its number or Login ID has been taken
 * since) and the employee's isActive as it was. An employee without a record
 * has no unique index behind their number, so before one is switched back on
 * the number is checked here every time, the rollback inside a request too.
 *
 * With `check` (the restore script), refuses first, writing nothing, when:
 *   - EMPLOYEE_NOT_FOUND       their shop has deleted the employee since;
 *   - EMPLOYEE_NUMBER_CHANGED  their shop has moved the employee to another
 *                              number since (the old one would sign in as them);
 *   - EMPLOYEE_HAS_LOGIN       their shop has given the employee a new sign-in
 *                              record since;
 *   - USER_ID_TAKEN            the owner's Login ID is someone else's now;
 *   - PHONE_ALREADY_REGISTERED the number is someone else's now.
 */
async function restoreRelease(entry, { check = false } = {}) {
  if (entry.restoredAt) return { restored: false, reason: 'ALREADY_RESTORED' };
  const original = entry.original || null;
  if (check) {
    if (entry.employeeId) {
      const employee = await Employee.findById(entry.employeeId).select('phone').lean();
      if (!employee) throw new Error('EMPLOYEE_NOT_FOUND');
      if (!isStoredPhone(entry.phone, employee.phone)) throw new Error('EMPLOYEE_NUMBER_CHANGED');
      const otherLogin = { employeeId: entry.employeeId, role: EMP };
      if (original) otherLogin._id = { $ne: original._id };
      if (await BusinessUser.exists(otherLogin)) throw new Error('EMPLOYEE_HAS_LOGIN');
    }
    if (original?.userId && await BusinessUser.exists({ userId: original.userId, _id: { $ne: original._id } })) {
      throw new Error('USER_ID_TAKEN');
    }
  }
  if (check || (!original && entry.previousIsActive === true)) {
    const except = { exceptEmployeeId: entry.employeeId, exceptUserId: original?._id || null };
    for (const phone of new Set([entry.phone, original?.phone].filter(Boolean))) {
      if (await isPhoneRegistered(phone, except)) throw phoneTaken();
    }
  }

  if (original && !(await BusinessUser.collection.findOne({ _id: original._id }))) {
    try {
      await BusinessUser.collection.insertOne(original);
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw duplicateFieldOf(error) === 'userId' ? new Error('USER_ID_TAKEN') : phoneTaken();
      }
      throw error;
    }
  }
  if (entry.employeeId && typeof entry.previousIsActive === 'boolean') {
    await Employee.updateOne({ _id: entry.employeeId }, { $set: { isActive: entry.previousIsActive } });
  }
  await ReleasedLogin.updateOne({ _id: entry._id }, { $set: { restoredAt: new Date() } });
  return { restored: true };
}

/**
 * Undoes a release whose employee (or account deletion) was then not
 * written, last step first. Never throws: an entry that cannot go back stays
 * in released_logins for scripts/restore_released_login.js, and says so in
 * the log.
 */
async function restoreReleased(released) {
  for (const entry of [...(released || [])].reverse()) {
    try {
      await restoreRelease(entry);
      console.info(`${logTagOf(entry)} restored`, { releasedId: String(entry._id), kind: entry.kind });
    } catch (error) {
      console.error(`${logTagOf(entry)} could not restore`, {
        releasedId: String(entry._id),
        kind: entry.kind,
        error: error.message,
      });
    }
  }
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
  classifyPhone,
  releasePhoneHolders,
  archiveRelease,
  restoreRelease,
  restoreReleased,
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
