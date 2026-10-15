const redisService = require('./redis.service');
const bhawService = require('./bhaw.service');

const isLiveRate = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The market MCX (24K, per 10 g): the figure most houses agree on, read off
 * the 3-minute board this process already holds (bhaw.service), so pricing
 * waits on no Redis call and, while the board is fresh, on no network at
 * all. The MCX the scheduler stored is used only when no board is in hand
 * (just after a start, or the feed down with nothing held), and null when
 * there is neither. There is no made-up fallback: a missing MCX used to read
 * as Rs 1,60,000 and every price was worked out on it without a word. A
 * caller with no other live MCX (the followed house's board line) has no
 * rate.
 */
const getLiveMcxRate24K = async () => {
  try {
    const boardRate = await bhawService.boardMcxSell();
    if (isLiveRate(boardRate)) return boardRate;
  } catch (error) {
    console.warn('[MCX Service] Could not read the MCX off the board:', error.message);
  }
  try {
    const cachedRate = await redisService.getMcxCache();
    if (isLiveRate(cachedRate)) {
      return cachedRate;
    }
    console.warn('[MCX Service] No MCX on the board and none stored yet.');
    return null;
  } catch (error) {
    console.error('[MCX Service] Failed to read cached MCX rate:', error.message);
    return null;
  }
};

module.exports = {
  getLiveMcxRate24K
};
