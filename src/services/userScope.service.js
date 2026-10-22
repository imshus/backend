const FormulaConfig = require('../models/formulaConfig.model');
const DashboardMetrics = require('../models/dashboardMetrics.model');
const GoldTaxSetting = require('../models/goldTaxSetting.model');
const Invoice = require('../models/invoice.model');
const { InvoiceCounter } = require('../models/invoiceCounter.model');
const GoldRate = require('../models/goldRate.model');
const DiamondRate = require('../models/diamondRate.model');
const ColorstoneRate = require('../models/colorstoneRate.model');
const BullionSource = require('../models/bullionSource.model');
const LabourRate = require('../models/labourRate.model');
const ItemCode = require('../models/itemCode.model');
const CustomCharge = require('../models/customCharge.model');

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

/**
 * Every record a user's setting can come from, nearest first: an employee's
 * own (when they have one) and the business's. For a setting whose own
 * record can exist with nothing in the field that matters — the shop's
 * answer then still stands behind it.
 */
const findScopedSettings = async (Model, scope) => {
  const [own, shop] = await Promise.all([
    scope.userId ? Model.findOne({ businessId: scope.businessId, userId: scope.userId }) : null,
    Model.findOne({ businessId: scope.businessId, userId: null }),
  ]);
  return [own, shop].filter(Boolean);
};

/** Writes the user's own record (the business record when the owner writes). */
const upsertScopedSetting = (Model, scope, set) =>
  Model.findOneAndUpdate(
    { businessId: scope.businessId, userId: scope.userId },
    { $set: set },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

/**
 * Rate tables (gold, diamond, colorstone) live per user the same way settings
 * do, but as whole tables rather than single documents: an employee starts on
 * the shop's rows and, the first time they change anything in a table, gets a
 * private copy of that whole table (copy-on-write) — so one edit never
 * strands them with a single-row table. The owner's rows are the shop's and
 * carry no userId.
 */

/** The rows a user reads from one rate table: their own set when it has any, else the shop's. */
const findScopedRows = async (Model, scope, extra = {}) => {
  if (scope.userId) {
    const own = await Model.find({ businessId: scope.businessId, userId: scope.userId, ...extra });
    if (own.length > 0) return own;
  }
  return Model.find({ businessId: scope.businessId, userId: null, ...extra });
};

/**
 * Gives an employee their own copy of a rate table before their first write
 * to it. Returns true when a copy was made. The owner never copies.
 */
const materializeOwnRows = async (Model, scope) => {
  if (!scope.userId) return false;
  const ownCount = await Model.countDocuments({ businessId: scope.businessId, userId: scope.userId });
  if (ownCount > 0) return false;
  const shopRows = await Model.find({ businessId: scope.businessId, userId: null }).lean();
  if (shopRows.length === 0) return false;
  await Model.insertMany(
    shopRows.map(({ _id, createdAt, updatedAt, __v, ...rest }) => ({ ...rest, userId: scope.userId })),
  );
  return true;
};

/**
 * Resolves an _id the client sent into the row the writer may touch. The id
 * may point at a shop row the employee was still inheriting; after their
 * table is materialized the matching row in their own set is found through
 * `keyFields`. Returns null when the id matches nothing of this business.
 */
const resolveScopedRowById = async (Model, scope, id, keyFields) => {
  const anyRow = await Model.findOne({ _id: id, businessId: scope.businessId });
  if (!anyRow) return null;
  const targetUserId = scope.userId ?? null;
  if (String(anyRow.userId ?? '') === String(targetUserId ?? '')) return anyRow;
  const keyFilter = {};
  for (const field of keyFields) keyFilter[field] = anyRow[field] ?? null;
  return Model.findOne({ businessId: scope.businessId, userId: targetUserId, ...keyFilter });
};

/**
 * The id a cache entry is filed under for this scope: the employee's own when
 * they have settings of their own, otherwise the shop's. Shared so a writer
 * and a reader cannot disagree about the key.
 */
const scopeCacheId = (scope) =>
  scope?.userId ? `${scope.businessId}:u:${scope.userId}` : String(scope?.businessId || 'global');

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
 * Checkout history lists invoices with fromCart. A server before that field
 * stored a cart's pieces without it (6a05ec6..303c32b, or the same after a
 * rollback); those are carts too. Only a cart request stores pieces, so
 * pieces without the flag means a cart. A no-op once every one is marked.
 */
const markCartInvoices = async () => {
  const { modifiedCount } = await Invoice.collection.updateMany(
    { pieces: { $exists: true }, fromCart: { $exists: false } },
    { $set: { fromCart: true } },
  );
  if (modifiedCount) console.log(`[DB] Marked ${modifiedCount} cart invoice(s) for Checkout history`);
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
  await markCartInvoices();
  await dropIndexIfPresent(InvoiceCounter, 'dateKey_1');
  await InvoiceCounter.syncIndexes();

  // Rate tables: the per-business unique indexes give way to per-user ones.
  await dropIndexIfPresent(GoldRate, 'businessId_1_carat_1');
  await GoldRate.syncIndexes();
  await dropIndexIfPresent(DiamondRate, 'businessId_1_color_1_clarity_1_shape_1');
  await dropIndexIfPresent(DiamondRate, 'businessId_1_packetCode_1');
  await DiamondRate.syncIndexes();
  await dropIndexIfPresent(ColorstoneRate, 'businessId_1_color_1_clarity_1');
  // The colour + clarity index became partial when colorstone rates gained a
  // packet code; the old full one has to go before the partial can take.
  await dropIndexIfPresent(ColorstoneRate, 'businessId_1_userId_1_color_1_clarity_1');
  await ColorstoneRate.syncIndexes();
  await dropIndexIfPresent(LabourRate, 'businessId_1');
  await LabourRate.syncIndexes();
  // Item codes: one code per business becomes one code per user's list.
  await dropIndexIfPresent(ItemCode, 'businessId_1_code_1');
  await ItemCode.syncIndexes();
  // The bullion house a shop follows, and the houses it added.
  await BullionSource.syncIndexes();
  // Charge names: the same, or two users could not keep the same name.
  await dropIndexIfPresent(CustomCharge, 'businessId_1_name_1');
  await CustomCharge.syncIndexes();

  console.log('[DB] Per-user settings, rates and per-business invoice indexes in place');
};

module.exports = {
  isOwnerRole,
  settingsScope,
  ownWorkFilter,
  findScopedSetting,
  findScopedSettings,
  upsertScopedSetting,
  findScopedRows,
  materializeOwnRows,
  resolveScopedRowById,
  scopeCacheId,
  ensureUserScopedIndexes,
  markCartInvoices,
};
