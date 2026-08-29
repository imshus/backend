const redisService = require('./redis.service');

const getLiveMcxRate24K = async () => {
  try {
    // 1. Check Redis Cache First
    const cachedRate = await redisService.getMcxCache();
    if (cachedRate) {
      return cachedRate;
    }

    // 2. Fallback if cache is empty (scheduler hasn't run yet)
    console.warn('[MCX Service] Cache is empty. Returning fallback rate until scheduler populates cache.');
    return 160000;
  } catch (error) {
    console.error('[MCX Service] Failed to read cached MCX rate:', error.message);
    return 160000;
  }
};

module.exports = {
  getLiveMcxRate24K
};
