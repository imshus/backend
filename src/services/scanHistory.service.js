const mongoose = require('mongoose');
const ScanHistory = require('../models/scanHistory.model');
const { ownWorkFilter } = require('./userScope.service');

/**
 * Settings -> History -> Tag scan history: every scan that was priced, newest
 * first, with what the card showed for it.
 */

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

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
  const itemName = String(itemRow?.description || '').trim()
    || [karat, typeNameOf(request?.jewelleryType || scan?.jewelleryType)].filter(Boolean).join(' ');
  return {
    itemName,
    karat,
    tagCode: String(request?.itemCode || '').trim(),
  };
}

/**
 * Records (or re-records) a priced scan for the account that priced it. The
 * latest price for a scan wins. Matched on the account as well as the scan,
 * so a scan id can only ever update its own scanner's line: another
 * account's request for it meets the unique index and writes nothing.
 *
 * Without a database connection (or a shop to file it under) nothing is
 * written: the history is a convenience, and never something a price waits
 * on or fails over. Returns whether a line was written.
 */
async function recordPricedScan({ user, scanId, itemName, karat, tagCode, finalMRP }) {
  const businessId = String(user?.businessId || '');
  const userId = String(user?.userId || '').trim();
  const id = String(scanId || '').trim();
  if (mongoose.connection.readyState !== 1) return false;
  if (!mongoose.isValidObjectId(businessId) || !userId || !id) return false;

  const filter = { businessId, scanId: id, userId };
  const update = {
    $set: {
      itemName: String(itemName || ''),
      karat: String(karat || ''),
      tagCode: String(tagCode || ''),
      finalMRP: Number.isFinite(Number(finalMRP)) ? Number(finalMRP) : 0,
    },
  };
  try {
    await ScanHistory.updateOne(filter, update, { upsert: true });
  } catch (error) {
    // Two prices for one scan landing together (the card's first request
    // and its prefetch): one inserts, the other finds the line taken and
    // updates it instead. A line that is another account's matches nothing.
    if (!isDuplicateKey(error)) throw error;
    const { matchedCount } = await ScanHistory.updateOne(filter, update);
    return matchedCount > 0;
  }
  return true;
}

/** The ?limit a list asks for: 30 by default, 1 to 100. */
function listLimitOf(raw) {
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, limit);
}

/**
 * A session's tag scan history, newest scan first: the shop's for an owner,
 * an employee's own for an employee (the rule GET /invoices keeps).
 */
async function listScans(user, { limit } = {}) {
  const items = await ScanHistory.find({ businessId: user.businessId, ...ownWorkFilter(user) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(listLimitOf(limit))
    .select('scanId itemName tagCode finalMRP createdAt')
    .lean();
  return items.map(({ scanId, itemName, tagCode, finalMRP, createdAt }) => ({
    scanId,
    itemName,
    tagCode,
    finalMRP,
    createdAt,
  }));
}

module.exports = {
  historyEntryOf,
  recordPricedScan,
  listScans,
  listLimitOf,
  typeNameOf,
};
