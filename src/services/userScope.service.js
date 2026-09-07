const FormulaConfig = require('../models/formulaConfig.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');
const GoldTaxSetting = require('../models/goldTaxSetting.model');
const Invoice = require('../models/invoice.model');
const { InvoiceCounter } = require('../models/invoiceCounter.model');

/**
 * Whose data a request touches.
 *
 * Two kinds of account use the app: the shop owner and the shop's employees.
 * The owner's settings are the shop's settings — they are stored without a
 * userId, which is the shape every record had before employees could keep
 * their own — and an employee inherits them until they save their own, which
 * is stored under their userId. Work an employee produces (invoices, wishlist
 * items) is theirs to see; the owner sees all of it.
 */

const OWNER_ROLES = new Set(['OWNER', 'BUSINESS', 'SUPER', 'SUPER_ADMIN', 'SUPERADMIN', 'SUPER ADMIN']);

const normalizeRole = (role) => String(role || '').trim().toUpperCase();

const isOwnerRole = (role) => OWNER_ROLES.has(normalizeRole(role));

/**
 * The scope a request's settings live in:
 *   { businessId, owner, userId } — userId is null for the owner (the
 *   business record) and the employee's id otherwise.
 */
const settingsScope = (user) => {
  const owner = isOwnerRole(user?.role);
  const userId = owner ? null : String(user?.userId || '').trim() || null;
  return { businessId: user?.businessId, owner, userId };
};

/** The filter that finds only this person's own work; empty for the owner. */
const ownWorkFilter = (user) =>
  isOwnerRole(user?.role) ? {} : { userId: String(user?.userId || '').trim() };

/** The record a user reads: their own when it exists, else the business's. */
const findScopedSetting = async (Model, scope) => {
  if (scope.userId) {
    const own = await Model.findOne({ businessId: scope.businessId, userId: scope.userId });
    if (own) return own;
  }
  // `userId: null` matches both the records written before this field existed
  // and the ones the owner writes now.
  return Model.findOne({ businessId: scope.businessId, userId: null });
};

/** Writes the user's own record (the business record when the owner writes). */
const upsertScopedSetting = (Model, scope, set) =>
  Model.findOneAndUpdate(
    { businessId: scope.businessId, userId: scope.userId },
    { $set: set },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

const isIndexMissing = (error) =>
  error?.codeName === 'IndexNotFound' || error?.code === 27 || /index not found/i.test(String(error?.message || ''));

const dropIndexIfPresent = async (Model, indexName) => {
  try {
    await Model.collection.dropIndex(indexName);
    console.log(`[DB] Dropped ${Model.modelName}.${indexName}`);
  } catch (error) {
    if (!isIndexMissing(error)) throw error;
  }
};

/**
 * The indexes that used to say "one record per business" and "one invoice
 * number in the world" give way to "one record per business per user" and
 * "one invoice number per business". Run once at startup; each step is a
 * no-op when it has already happened.
 */
const ensureUserScopedIndexes = async () => {
  for (const Model of [FormulaConfig, DashboardMetrics, GoldTaxSetting]) {
    await dropIndexIfPresent(Model, 'businessId_1');
    await Model.syncIndexes();
  }
  await dropIndexIfPresent(Invoice, 'invoiceNumber_1');
  await Invoice.syncIndexes();
  await dropIndexIfPresent(InvoiceCounter, 'dateKey_1');
  await InvoiceCounter.syncIndexes();
  console.log('[DB] Per-user settings and per-business invoice indexes in place');
};

module.exports = {
  isOwnerRole,
  settingsScope,
  ownWorkFilter,
  findScopedSetting,
  upsertScopedSetting,
  ensureUserScopedIndexes,
};
