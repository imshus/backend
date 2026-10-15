const redisService = require('./redis.service');

/**
 * The stored market MCX (24K, per 10 g) the scheduler keeps, or null when
 * there is none. There is no made-up fallback: a missing MCX used to read as
 * Rs 1,60,000 and every price was worked out on it without a word. A caller
 * with no other live MCX (the followed house's board line) has no rate.
 */
const getLiveMcxRate24K = async () => {
  try {
    const cachedRate = await redisService.getMcxCache();
    if (typeof cachedRate === 'number' && Number.isFinite(cachedRate) && cachedRate > 0) {
      return cachedRate;
    }
    console.warn('[MCX Service] No stored MCX rate yet (the scheduler has not stored one).');
    return null;
  } catch (error) {
    console.error('[MCX Service] Failed to read cached MCX rate:', error.message);
    return null;
  }
};

module.exports = {
  getLiveMcxRate24K
};
