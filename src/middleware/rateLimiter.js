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

module.exports = {
  gstRateLimiter
};
