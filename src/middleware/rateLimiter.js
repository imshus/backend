const redisClient = require('../redis/redisClient');

const gstRateLimiter = async (req, res, next) => {
  try {
    const ip = req.ip || req.connection.remoteAddress;
    const hrKey = `gst_limit_hr:${ip}`;
    const dayKey = `gst_limit_day:${ip}`;

    let hrCount = await redisClient.get(hrKey);
    if (hrCount && parseInt(hrCount) >= 20) {
      return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Maximum 20 GST verifications per hour allowed.' });
    }

    let dayCount = await redisClient.get(dayKey);
    if (dayCount && parseInt(dayCount) >= 60) {
      return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Maximum 10 GST verifications per 24 hours allowed.' });
    }

    if (hrCount) {
      await redisClient.incr(hrKey);
    } else {
      await redisClient.set(hrKey, '1', 'EX', 3600);
    }

    if (dayCount) {
      await redisClient.incr(dayKey);
    } else {
      await redisClient.set(dayKey, '1', 'EX', 86400);
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * A per-account counter for an endpoint that spends a paid model call without
 * debiting a credit. Keyed by user and business rather than IP: a shop's
 * phones sit behind one NAT, and the point is to stop one login looping it.
 */
const perUserLimiter = ({ name, limit, windowSeconds, message }) => async (req, res, next) => {
  try {
    const who = `${req.user?.businessId || 'anon'}:${req.user?.userId || req.ip}`;
    const key = `${name}_limit:${who}`;
    const count = await redisClient.get(key);
    if (count && parseInt(count, 10) >= limit) {
      return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message });
    }
    if (count) {
      await redisClient.incr(key);
    } else {
      await redisClient.set(key, '1', 'EX', windowSeconds);
    }
    next();
  } catch (error) {
    next(error);
  }
};

// One gallery pick is one detection; 120 an hour is far beyond a person
// and a firm cap on a script. A refused call just means framing by hand.
const detectTagRateLimiter = perUserLimiter({
  name: 'detect_tag',
  limit: 120,
  windowSeconds: 3600,
  message: 'Too many photo detections this hour. Frame the tag by hand for now.',
});

module.exports = {
  gstRateLimiter,
  perUserLimiter,
  detectTagRateLimiter,
};
