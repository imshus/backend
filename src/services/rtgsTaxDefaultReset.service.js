/**
 * RTGS Rate 2's Tax box: the old default of 3, taken off the records that
 * still carry it. Run once, at startup.
 *
 * The Tax box started at 3 for a while (the schema default was 3 on 22 Sep
 * and again from 27 Sep until the next day), and a settings record created
 * in those windows got that 3 written in on its first save, whether the shop
 * ever touched the box or not. The default is 0 now, but a saved number is
 * what a shop is taken to have chosen, so those records kept pricing Rate 2
 * 3% under the board figure.
 *
 * Every record at exactly 3 becomes 0, once. A marker records that it ran,
 * so a shop that types 3 afterwards keeps it; one that typed another number
 * is not touched. Each shop changed has its cached rates dropped.
 */
const mongoose = require('mongoose');

const GoldTaxSetting = require('../models/goldTaxSetting.model');
const redisService = require('./redis.service');

const MARKER_ID = 'rtgs-tax-default-3-to-0';
const OLD_DEFAULT = 3;
const NEW_DEFAULT = 0;

/** The collection that records one-off startup steps already taken. */
const defaultMarkers = () => mongoose.connection.db.collection('app_migrations');

/**
 * @param {object} [deps] Stand-ins for tests; the real ones by default.
 * @returns {Promise<{ran: boolean, changed: number}>}
 */
async function resetOldRtgsTaxDefault({
  Model = GoldTaxSetting,
  markers = defaultMarkers(),
  invalidate = redisService.invalidateGoldRatesCache,
  log = console,
} = {}) {
  // Claimed before the change, so two servers starting together do not both
  // run it; released again if the change fails, so the next start retries.
  try {
    await markers.insertOne({ _id: MARKER_ID, startedAt: new Date() });
  } catch (error) {
    if (error && error.code === 11000) return { ran: false, changed: 0 };
    throw error;
  }

  try {
    const records = await Model.find({ rtgsTaxPercent: OLD_DEFAULT }, { businessId: 1 }).lean();
    const result = records.length
      ? await Model.updateMany({ rtgsTaxPercent: OLD_DEFAULT }, { $set: { rtgsTaxPercent: NEW_DEFAULT } })
      : { modifiedCount: 0 };
    const changed = Number(result.modifiedCount ?? result.nModified ?? 0);

    const businessIds = [...new Set(records.map((record) => String(record.businessId)))];
    for (const businessId of businessIds) {
      try {
        await invalidate(businessId);
      } catch (error) {
        // The rate cache also turns over with the deploy and the next board
        // move; a Redis hiccup here is not worth failing the start for.
        log.warn('[RTGS_TAX_RESET] cache not cleared for', businessId, error.message || error);
      }
    }

    await markers.updateOne(
      { _id: MARKER_ID },
      { $set: { finishedAt: new Date(), changed, businesses: businessIds.length } },
    );
    log.info('[RTGS_TAX_RESET]', { from: OLD_DEFAULT, to: NEW_DEFAULT, changed, businesses: businessIds.length });
    return { ran: true, changed };
  } catch (error) {
    await markers.deleteOne({ _id: MARKER_ID }).catch(() => {});
    throw error;
  }
}

module.exports = { resetOldRtgsTaxDefault, MARKER_ID };
