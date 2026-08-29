const axios = require('axios');

// JMD Patil live bhaw feed (premium/discount over MCX).
// GET -> { source, name, cash_bhaw, rtgs_bhaw, updated_at }
const BHAW_URL = 'https://17gdivfex7.execute-api.ap-south-1.amazonaws.com/bhaw';
const CACHE_TTL_MS = 30_000;

let cache = { data: null, fetchedAt: 0 };

const toFiniteNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const getJmdBhaw = async () => {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data;

  try {
    const response = await axios.get(BHAW_URL, { timeout: 5000 });
    const cashBhaw = toFiniteNumber(response.data?.cash_bhaw);
    const rtgsBhaw = toFiniteNumber(response.data?.rtgs_bhaw);
    if (cashBhaw === null || rtgsBhaw === null) {
      return cache.data; // vendor hasn't updated yet — serve stale if we have it
    }
    cache = { data: { cashBhaw, rtgsBhaw }, fetchedAt: now };
    return cache.data;
  } catch (error) {
    console.warn('[Bhaw] Failed to fetch JMD bhaw feed:', error.message);
    return cache.data; // serve stale on failure
  }
};

module.exports = { getJmdBhaw };
