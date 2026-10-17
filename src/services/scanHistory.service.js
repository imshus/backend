const mongoose = require('mongoose');
const ScanHistory = require('../models/scanHistory.model');
const { ownWorkFilter } = require('./userScope.service');
const { fieldText, findItemOnTag, resolveKaratFromReading } = require('./pricingInputs');
const { tagIdentifiersOf } = require('../utils/tagIdentifiers');
const { listLimitOf, pageQuery, readPage } = require('./historyPage');

/**
 * Settings -> History -> Tag scan history: every scan from the moment its tag
 * is read, newest first, with what the card showed for it, and a page of its
 * own with everything read off the tag and the latest price's workings.
 */

// The jewellery types the scanner prices, as a history line names them. The
// app sends 'Gold' / 'Diamond'; a scan record carries 'GOLD' / 'DIAMOND'.
const TYPE_NAMES = {
  GOLD: 'Gold',
  DIAMOND: 'Diamond Jewellery',
  SILVER: 'Silver',
  COLOUR_STONE: 'Colour Stone Jewellery',
  COLORSTONE: 'Colour Stone Jewellery',
};

const typeNameOf = (jewelleryType) =>
  TYPE_NAMES[String(jewelleryType || '').trim().toUpperCase().replace(/[\s-]+/g, '_')] || 'Jewellery';

const isDuplicateKey = (error) => error?.code === 11000;

/** The name a line carries: the Masters item's, else "<karat> <type>" ("22K Gold"). */
const itemNameOf = (itemRow, karat, jewelleryType) =>
  String(itemRow?.description || '').trim()
  || [String(karat || '').trim(), typeNameOf(jewelleryType)].filter(Boolean).join(' ');

/**
 * What a history line says about the piece that was priced, from the
 * calculation's own input (`request`, pricingInputs validateCalculationInput)
 * and the Masters item the tag matched (`itemRow`, if any):
 *   - itemName: the item's name (its description in Masters -> Item Code),
 *     else the karat and type that were priced: "22K Gold";
 *   - tagCode: the item number the card shows, '' when it has none.
 */
function historyEntryOf({ request, itemRow, scan } = {}) {
  const karat = String(request?.purityKarat || '').trim();
  return {
    itemName: itemNameOf(itemRow, karat, request?.jewelleryType || scan?.jewelleryType),
    karat,
    tagCode: String(request?.itemCode || '').trim(),
  };
}

// ── What was read ─────────────────────────────────────────────────────

const DIAMOND_FIELDS = ['weight', 'unit', 'pieces', 'shape', 'quality', 'color', 'clarity', 'rate', 'packetCode'];
const COLORSTONE_FIELDS = ['type', ...DIAMOND_FIELDS];

/** A reading's stone list (an array, or the JSON text of one) as plain rows, blank rows left out. */
function plainStones(raw, fields) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  return (Array.isArray(list) ? list : [])
    .filter((stone) => stone && typeof stone === 'object')
    .map((stone) => Object.fromEntries(fields.map((key) => [key, fieldText(stone[key])])))
    // The reader's schema always has one stone row; an empty one is no stone.
    .filter((stone) => Object.values(stone).some(Boolean));
}

/**
 * Everything the analysis read off a tag, as plain values: each field as the
 * text the reader returned, without its confidence ('' when the tag did not
 * print it). `itemCode` is the Masters item the tag's number matched ('' when
 * none); `tagIdentifiers` every identifier the tag prints, main one first.
 */
function readingDetailsOf({ analysisResult, jewelleryType, itemRow } = {}) {
  const data = analysisResult?.structuredData || {};
  const text = (key) => fieldText(data[key]);
  const raw = analysisResult?.rawText;
  return {
    jewelleryType: String(jewelleryType || text('jewelleryType') || ''),
    grossWeight: text('grossWeight'),
    netWeight: text('netWeight'),
    karat: text('karat'),
    purity: text('purity'),
    serialNumber: text('serialNumber'),
    itemCode: itemRow ? String(itemRow.code || '') : '',
    packetCode: text('packetCode'),
    tagIdentifiers: tagIdentifiersOf(analysisResult || {}),
    diamonds: plainStones(data.diamonds, DIAMOND_FIELDS),
    colorstones: plainStones(data.colorstones, COLORSTONE_FIELDS),
    labour: text('labour'),
    wastage: text('wastage'),
    otherCharges: text('otherCharges'),
    // The tag's printed text, line by line, as the reader transcribed it.
    rawText: typeof raw === 'string' ? raw : String(raw?.merged ?? ''),
  };
}

/** Blank and repeated (ignoring case) identifiers dropped, the order kept. */
function distinctIdentifiers(values) {
  const seen = new Set();
  return values
    .map((value) => String(value ?? '').trim())
    .filter((value) => {
      const key = value.toUpperCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The line a fresh reading starts, from the scan record the analysis
 * returned (`scan`, with its analysisResult) and the price worked out from
 * it (`computed`, mrpCalculation.service computeMrp's answer; null when the
 * reading could not be priced):
 *   - itemName / karat / tagCode as a price for it would name them: the
 *     Masters item the price matched, else (no price) the item any of the
 *     tag's identifiers names in `itemRows` (the shop's Masters -> Item
 *     Code, read beside the model call), else "<karat> <type>";
 *   - finalMRP: that price to the rupee, null without one;
 *   - details: everything read (readingDetailsOf).
 */
function readEntryOf({ scan, computed = null, itemRows = [] } = {}) {
  const analysisResult = scan?.analysisResult || {};
  const data = analysisResult.structuredData || {};
  const serialNumber = fieldText(data.serialNumber);
  let itemRow = computed ? computed.itemRow || null : null;
  if (!computed) {
    const rows = (Array.isArray(itemRows) ? itemRows : [])
      .map((row) => (typeof row?.toObject === 'function' ? row.toObject() : row));
    const identifiers = distinctIdentifiers([serialNumber, ...tagIdentifiersOf(analysisResult)]);
    itemRow = findItemOnTag(identifiers, rows)?.row || null;
  }
  const karat = String(computed?.request?.purityKarat || resolveKaratFromReading(data));
  const jewelleryType = scan?.jewelleryType || fieldText(data.jewelleryType);
  const finalMRP = Number(computed?.resultData?.finalMRPRounded);
  return {
    itemName: itemNameOf(itemRow, karat, jewelleryType),
    karat,
    tagCode: serialNumber,
    finalMRP: computed && Number.isFinite(finalMRP) ? finalMRP : null,
    details: readingDetailsOf({ analysisResult, jewelleryType, itemRow }),
  };
}

// ── What was priced ───────────────────────────────────────────────────

/**
 * A price as the line keeps it, from computeMrp's answer:
 *   - inputs: the card's request as it was read (pricingInputs
 *     validateCalculationInput), named as the /calculate body names them,
 *     with the rate mode it was priced in (an employee's permissions can
 *     overrule the one asked for);
 *   - breakdown: the breakdown the card was answered with, plus the 24K rate
 *     per 10 g, the purity and the gold rate after it, each stone's line and
 *     the labour rate, unit and weight applied;
 *   - rules: the pricing rules it was priced by (X-Pricing-Rules).
 */
function pricingRecordOf({ request, resultData, resolvedMode, applied } = {}) {
  const { breakdown = {}, finalMRP = null, finalMRPRounded = null } = resultData || {};
  const labour = applied?.labour || null;
  return {
    inputs: {
      jewelleryType: request?.jewelleryType ?? null,
      grossWt: request?.grossWt ?? 0,
      netWt: request?.netWt ?? 0,
      purityKarat: request?.purityKarat || '',
      customPurityPercent: request?.customPurityPercent ?? null,
      calculationMode: resolvedMode || null,
      diamonds: request?.diamonds || [],
      colorstones: request?.colorstones || [],
      labourChargeAmount: request?.manualLabour ? request.manualLabour.amount : null,
      labourChargeUnit: request?.manualLabour ? request.manualLabour.unit : null,
      labourWeightBasis: request?.labourWeightBasis ?? null,
      wastagePercent: request?.wastagePercent ?? null,
      wastageWeightBasis: request?.wastageWeightBasis ?? null,
      otherCharges: request?.otherCharges ?? 0,
      itemCode: request?.itemCode || '',
      tagIdentifiers: request?.tagIdentifiers || [],
    },
    breakdown: {
      ...breakdown,
      goldRatePer10g: applied?.goldRatePer10g ?? null,
      effectivePurityPercent: applied?.effectivePurityPercent ?? null,
      purityAdjustedGoldRatePerGram: applied?.purityAdjustedGoldRatePerGram ?? null,
      diamondLineItems: applied?.diamondLineItems || [],
      colorstoneLineItems: applied?.colorstoneLineItems || [],
      labourRate: labour ? labour.ratePerUnit : null,
      labourUnit: labour ? labour.unit : null,
      labourWeightBasis: labour ? labour.basis : null,
      finalMRP,
      finalMRPRounded,
    },
    rules: applied?.rules ?? null,
  };
}

// ── Writing a line ────────────────────────────────────────────────────

/** The shop, account and scan a write is for, or null when one is missing. */
function writeKeyOf(user, scanId) {
  const businessId = String(user?.businessId || '');
  const userId = String(user?.userId || '').trim();
  const id = String(scanId || '').trim();
  if (mongoose.connection.readyState !== 1) return null;
  if (!mongoose.isValidObjectId(businessId) || !userId || !id) return null;
  return { businessId, userId, scanId: id };
}

/**
 * Starts a scan's line the moment its tag is read: status 'read', the
 * reading's price (or null) and everything read. Only the analysis calls it,
 * after its scan record proved the id is the caller's.
 *
 * A price the card asked for may land first (the card can ask as soon as
 * the reading arrives, and this is written after the analysis has
 * answered): the reading then only adds its `details`, and the price, the
 * status and the line's time stay the card's. A line still at 'read' (the
 * same scan read again) takes the new reading whole. Matched on the account
 * as well as the scan, so another account's line for the id is never
 * touched. Without a database connection (or a shop to file it under)
 * nothing is written. Returns whether a line was written.
 */
async function recordReadScan({ user, scanId, itemName, karat, tagCode, finalMRP = null, details = null }) {
  const key = writeKeyOf(user, scanId);
  if (!key) return false;
  const price = finalMRP === null || finalMRP === undefined || !Number.isFinite(Number(finalMRP))
    ? null
    : Number(finalMRP);
  const summary = {
    itemName: String(itemName || ''),
    karat: String(karat || ''),
    tagCode: String(tagCode || ''),
    finalMRP: price,
  };

  const reread = await ScanHistory.updateOne(
    { ...key, status: 'read' },
    { $set: { ...summary, details } },
  );
  if (reread.matchedCount > 0) return true;

  try {
    await ScanHistory.updateOne(
      key,
      { $set: { details }, $setOnInsert: { ...summary, status: 'read' } },
      { upsert: true },
    );
  } catch (error) {
    // A line this filter missed: a price written between the two steps, or
    // another account's line for the id (which only the first matches).
    if (!isDuplicateKey(error)) throw error;
    const { matchedCount } = await ScanHistory.updateOne(key, { $set: { details } });
    return matchedCount > 0;
  }
  return true;
}

/**
 * Records (or re-records) a priced scan for the account that priced it:
 * status 'priced', the price and, when given, its workings (`pricing`,
 * pricingRecordOf). Matched on the account as well as the scan, so a scan id
 * can only ever update its own scanner's line: another account's request for
 * it meets the unique index and writes nothing. What was read (`details`)
 * and the line's time are left as they are.
 *
 * `pricedAt` is when the request that priced it arrived, and the latest
 * request wins: a price only replaces one asked for no later than it, so of
 * two in flight for one scan (the processing screen's prefetch and the
 * card's own, or two quick edits) the older one landing last changes nothing.
 *
 * `mayCreate`: whether a new line may be started, only when a scan record
 * proved the id is the caller's. Without one (a card left open after its
 * record was dropped, or an id nobody scanned) a line the caller already has
 * is updated and nothing new is made, so made-up scan ids add no lines.
 *
 * Without a database connection (or a shop to file it under) nothing is
 * written: the history is a convenience, and never something a price waits
 * on or fails over. Returns whether a line was written.
 */
async function recordPricedScan({
  user, scanId, itemName, karat, tagCode, finalMRP, pricing = null, pricedAt = new Date(), mayCreate = false,
}) {
  const key = writeKeyOf(user, scanId);
  if (!key) return false;
  const at = pricedAt instanceof Date && !Number.isNaN(pricedAt.getTime()) ? pricedAt : new Date();

  const filter = {
    ...key,
    $or: [{ pricedAt: { $lte: at } }, { pricedAt: { $exists: false } }],
  };
  const update = {
    $set: {
      status: 'priced',
      itemName: String(itemName || ''),
      karat: String(karat || ''),
      tagCode: String(tagCode || ''),
      finalMRP: Number.isFinite(Number(finalMRP)) ? Number(finalMRP) : 0,
      pricing: pricing || null,
      pricedAt: at,
    },
  };
  if (!mayCreate) {
    const { matchedCount } = await ScanHistory.updateOne(filter, update);
    return matchedCount > 0;
  }
  try {
    await ScanHistory.updateOne(filter, update, { upsert: true });
  } catch (error) {
    // The scan has a line this filter missed: another price for it got there
    // first (the line is then updated if this one is the later), a newer
    // price is on it already, or it is another account's. Only the first
    // matches here.
    if (!isDuplicateKey(error)) throw error;
    const { matchedCount } = await ScanHistory.updateOne(filter, update);
    return matchedCount > 0;
  }
  return true;
}

// ── Reading the history ───────────────────────────────────────────────

/** Whose lines a session sees: the shop's for an owner, its own for an employee (as GET /invoices). */
const visibleFilter = (user) => ({ businessId: user.businessId, ...ownWorkFilter(user) });

// A line written before statuses were kept was priced.
const statusOf = (line) => line.status || 'priced';

/**
 * The query behind listScans. Its filter and order are the two compound
 * indexes' (scanHistory.model), so it reads the lines it returns and no more,
 * however many the shop has kept.
 */
function scansQuery(user, { limit, before } = {}) {
  return pageQuery(ScanHistory, visibleFilter(user), { limit, before })
    .select('scanId itemName tagCode finalMRP status createdAt');
}

/**
 * A page of a session's tag scan history, newest scan first:
 * { items: [{ id, scanId, itemName, tagCode, finalMRP, status, createdAt }],
 *   nextCursor }. Throws historyPage InvalidCursorError for a bad `before`.
 */
async function listScans(user, { limit, before } = {}) {
  const { lines, nextCursor } = await readPage(scansQuery(user, { limit, before }), { limit });
  return {
    items: lines.map((line) => ({
      id: String(line._id),
      scanId: line.scanId,
      itemName: line.itemName,
      tagCode: line.tagCode,
      finalMRP: line.finalMRP ?? null,
      status: statusOf(line),
      createdAt: line.createdAt,
    })),
    nextCursor,
  };
}

/** One scan's whole line, or null when the session may not see it (or there is none). */
async function getScan(user, scanId) {
  const id = String(scanId || '').trim();
  if (!id) return null;
  const line = await ScanHistory.findOne({ ...visibleFilter(user), scanId: id }).lean();
  if (!line) return null;
  return {
    id: String(line._id),
    scanId: line.scanId,
    itemName: line.itemName,
    tagCode: line.tagCode,
    finalMRP: line.finalMRP ?? null,
    status: statusOf(line),
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
    details: line.details ?? null,
    pricing: line.pricing ?? null,
  };
}

module.exports = {
  historyEntryOf,
  readEntryOf,
  readingDetailsOf,
  pricingRecordOf,
  recordReadScan,
  recordPricedScan,
  scansQuery,
  listScans,
  getScan,
  listLimitOf,
  typeNameOf,
};
